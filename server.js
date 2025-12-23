require('dotenv').config();
const fs = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const YAML = require('yaml');
const zipcodes = require('zipcodes');
const fetch = global.fetch;

const app = express();
const port = process.env.PORT || 3000;

const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));
const dataDir = path.join(__dirname, 'data');
const presidentCacheFile = path.join(dataDir, 'president.json');
const presidentSeedFile = path.join(dataDir, 'president.seed.json');
const presidentTtlMs = Number(process.env.PRESIDENT_CACHE_TTL_HOURS || 6) * 60 * 60 * 1000;
const rosterCacheFile = path.join(dataDir, 'roster.json');
const rosterTtlMs = Number(process.env.ROSTER_CACHE_TTL_HOURS || 12) * 60 * 60 * 1000;
const votingStates = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY'
]);
const presidentSources = {
  general: 'https://www.realclearpolling.com/polls/approval/donald-trump/approval-rating',
  economy: 'https://www.realclearpolling.com/polls/approval/donald-trump/issues/economy',
  inflation: 'https://www.realclearpolling.com/polls/approval/donald-trump/issues/inflation',
  immigration: 'https://www.realclearpolling.com/polls/approval/donald-trump/issues/immigration',
};
const presidentDataEndpoints = {
  general: 'https://www.realclearpolitics.com/poll/race/8656/polling_data.json',
  economy: 'https://www.realclearpolitics.com/poll/race/8666/polling_data.json',
  inflation: 'https://www.realclearpolitics.com/poll/race/8661/polling_data.json',
  immigration: 'https://www.realclearpolitics.com/poll/race/8659/polling_data.json',
};
const rosterSources = [
  'https://raw.githubusercontent.com/unitedstates/congress-legislators/master/legislators-current.json',
  'https://theunitedstates.io/congress-legislators/legislators-current.json',
];
const rosterSeedFiles = [
  { name: 'roster.local.json', type: 'json' },
  { name: 'legislators-current.json', type: 'json' },
  { name: 'legislators-current.yaml', type: 'yaml' },
];
const propublicaKey = process.env.PROPUBLICA_API_KEY;
const congressGovKey = process.env.CONGRESS_GOV_API_KEY;
const propublicaCongress = process.env.CONGRESS_NUMBER || 118;
const recentVotesLimit = Number(process.env.RECENT_VOTES_LIMIT || 30);
const zipDistrictFile = path.join(dataDir, 'us_districts.csv');
const zipDistrictFallbackFile = path.join(dataDir, 'zip-house.csv');

const fallbackPresident = {
  name: 'Donald J. Trump',
  party: 'R',
  alignment: null,
  approval: null,
  issues: { economy: null, inflation: null, immigration: null },
  sources: Object.values(presidentSources),
  updatedAt: null,
};

let zipDistrictCache = { loaded: false, map: new Map() };

// Format district code consistently (e.g., "CA-17", "AL-4" -> "AL-04")
function formatDistrictCode(state, district) {
  if (!state) return '';
  if (district === undefined || district === null || district === '' || district === 0 || district === '0' || district === 'AL') {
    return `${state}-AL`;
  }
  const num = Number(district);
  if (Number.isFinite(num) && num > 0) {
    return `${state}-${String(num).padStart(2, '0')}`;
  }
  return `${state}-${district}`;
}

// Normalize district code for comparison (e.g., "AL-4" and "AL-04" both become "AL-04")
function normalizeDistrictCode(code) {
  if (!code) return '';
  const parts = code.toUpperCase().split('-');
  if (parts.length !== 2) return code.toUpperCase();
  const state = parts[0];
  const district = parts[1];
  if (district === 'AL' || district === '0' || district === '00') {
    return `${state}-AL`;
  }
  const num = Number(district);
  if (Number.isFinite(num) && num > 0) {
    return `${state}-${String(num).padStart(2, '0')}`;
  }
  return code.toUpperCase();
}

// Load ZIP to congressional district mapping
async function loadZipDistricts() {
  if (zipDistrictCache.loaded) return zipDistrictCache.map;

  const map = new Map();

  // Try primary file first (us_districts.csv)
  try {
    const raw = await fs.readFile(zipDistrictFile, 'utf-8');
    const lines = raw.trim().split(/\r?\n/);
    const [headerLine, ...rows] = lines;
    const headers = headerLine.split(',').map(h => h.trim().toLowerCase());
    const stateIdx = headers.indexOf('state_abbr');
    const zcIdx = headers.indexOf('zcta');
    const cdIdx = headers.indexOf('cd');

    if (stateIdx !== -1 && zcIdx !== -1 && cdIdx !== -1) {
      for (const line of rows) {
        const cols = line.split(',');
        const state = (cols[stateIdx] || '').trim().toUpperCase();
        const zip = (cols[zcIdx] || '').trim();
        const cd = (cols[cdIdx] || '').trim();
        if (zip && state && cd) {
          const districtCode = formatDistrictCode(state, cd);
          if (!map.has(zip)) map.set(zip, new Set());
          map.get(zip).add(districtCode);
        }
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('us_districts.csv load error', err.message || err);
  }

  // Fallback to zip-house.csv if primary is empty
  if (map.size === 0) {
    try {
      const raw = await fs.readFile(zipDistrictFallbackFile, 'utf-8');
      const lines = raw.trim().split(/\r?\n/);
      const [headerLine, ...rows] = lines;
      const headers = headerLine.split(',').map(h => h.trim().toLowerCase());
      const stateIdx = headers.indexOf('state');
      const zipIdx = headers.indexOf('zip');
      const districtIdx = headers.indexOf('district');

      if (stateIdx !== -1 && zipIdx !== -1 && districtIdx !== -1) {
        for (const line of rows) {
          const cols = line.split(',');
          const state = (cols[stateIdx] || '').trim().toUpperCase();
          const zip = (cols[zipIdx] || '').trim();
          const district = (cols[districtIdx] || '').trim();
          if (zip && state) {
            const districtCode = formatDistrictCode(state, district);
            if (!map.has(zip)) map.set(zip, new Set());
            map.get(zip).add(districtCode);
          }
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn('zip-house.csv load error', err.message || err);
    }
  }

  zipDistrictCache = { loaded: true, map };
  return map;
}

async function readJSON(file) {
  const full = path.join(dataDir, file);
  const raw = await fs.readFile(full, 'utf-8');
  return JSON.parse(raw);
}

async function readPresidentSeed() {
  try {
    const raw = await fs.readFile(presidentSeedFile, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.name) return parsed;
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('president seed read error', err.message || err);
  }
  return null;
}

async function readCSV(file) {
  const full = path.join(dataDir, file);
  const raw = await fs.readFile(full, 'utf-8');
  const lines = raw.trim().split(/\r?\n/);
  const [headerLine, ...rows] = lines;
  const headers = headerLine.split(',').map(h => h.trim());
  return rows
    .map((line) => {
      // Simple CSV parser that handles quoted commas
      const cols = [];
      let current = '';
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') inQuotes = !inQuotes;
        else if (char === ',' && !inQuotes) {
          cols.push(current.trim());
          current = '';
        } else {
          current += char;
        }
      }
      cols.push(current.trim());
      return Object.fromEntries(headers.map((h, idx) => [h, cols[idx] || '']));
    });
}

async function fetchRcpApproval(url) {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'actualapproval.com scraper (+https://github.com/actualapproval)' },
    });
    if (!res.ok) throw new Error(`fetch ${url} failed with ${res.status}`);
    const data = await res.json();
    const polls = data.poll || [];
    const rcpAvg = polls.find(p => p.type === 'rcp_average');
    if (!rcpAvg) throw new Error(`no rcp_average found in ${url}`);
    const approve = rcpAvg.candidate.find(c => c.name === 'Approve');
    if (!approve) throw new Error(`no Approve candidate found in ${url}`);
    return Number.parseFloat(approve.value) / 100;
  } catch (err) {
    console.error(`Error fetching RCP approval from ${url}:`, err.message);
    return null;
  }
}

async function loadPresident() {
  let cached = null;
  let cacheMtime = 0;
  try {
    const stat = await fs.stat(presidentCacheFile);
    cacheMtime = stat.mtimeMs;
    cached = await readJSON('president.json');
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('president cache read error', err);
  }

  const now = Date.now();
  const cacheFresh = cached && now - cacheMtime < presidentTtlMs && cached.name === 'Donald J. Trump';
  if (cacheFresh) return cached;

  const offlineMode = process.env.OFFLINE_MODE === '1';
  if (offlineMode) {
    const seeded = (await readPresidentSeed()) || fallbackPresident;
    const offline = {
      ...seeded,
      alignment: null,
      votes: { yes: 0, total: 0 },
      updatedAt: new Date().toISOString()
    };
    await fs.writeFile(presidentCacheFile, JSON.stringify(offline, null, 2));
    return offline;
  }

  try {
    // Fetch all approval data from RCP JSON endpoints
    const [approval, economy, inflation, immigration] = await Promise.all([
      fetchRcpApproval(presidentDataEndpoints.general),
      fetchRcpApproval(presidentDataEndpoints.economy),
      fetchRcpApproval(presidentDataEndpoints.inflation),
      fetchRcpApproval(presidentDataEndpoints.immigration),
    ]);
    const president = {
      name: 'Donald J. Trump',
      party: 'R',
      alignment: null, // Alignment for President is not yet calculated from EOs
      approval,
      issues: { economy, inflation, immigration },
      votes: { yes: 0, total: 0 }, // Placeholder for executive orders
      sources: Object.values(presidentSources),
      updatedAt: new Date().toISOString(),
    };
    await fs.writeFile(presidentCacheFile, JSON.stringify(president, null, 2));
    return president;
  } catch (err) {
    console.error('president scrape failed', err);
    const seeded = (await readPresidentSeed()) || fallbackPresident;
    const fallback = { ...seeded, updatedAt: new Date().toISOString() };
    await fs.writeFile(presidentCacheFile, JSON.stringify(fallback, null, 2));
    return fallback;
  }
}

function classifyYes(position) {
  const val = (position || '').toLowerCase();
  return val === 'yes' || val === 'yea' || val === 'aye';
}

function classifyNo(position) {
  const val = (position || '').toLowerCase();
  return val === 'no' || val === 'nay';
}

async function calculateAlignmentFromDatabase() {
  try {
    const votesPath = path.join(dataDir, 'votes.json');
    const raw = await fs.readFile(votesPath, 'utf-8');
    const votesDb = JSON.parse(raw);

    const results = { house: [], senate: [] };

    for (const chamber of ['house', 'senate']) {
      const chamberVotes = votesDb[chamber] || {};
      const memberStats = new Map();

      for (const voteId in chamberVotes) {
        const vote = chamberVotes[voteId];
        const bill = vote.bill;
        const positions = vote.positions;

        for (const bioId in positions) {
          const pos = positions[bioId];
          const isYes = classifyYes(pos);

          const stats = memberStats.get(bioId) || {
            id: bioId,
            votes: { yes: 0, total: 0 },
            flaggedVotes: []
          };

          stats.votes.total += 1;
          if (isYes) stats.votes.yes += 1;

          stats.flaggedVotes.push({
            question: `${bill["Bill Title"]} - ${bill["Short Description"]}`,
            date: bill["Last Vote Year"],
            position: pos
          });

          memberStats.set(bioId, stats);
        }
      }

      results[chamber] = Array.from(memberStats.values()).map(s => ({
        ...s,
        alignment: s.votes.total ? s.votes.yes / s.votes.total : 0
      }));
    }

    return results;
  } catch (err) {
    console.error('Failed to calculate alignment from database', err);
    return { house: [], senate: [] };
  }
}

function normalizeName(name) {
  return name
    .toLowerCase()
    .replace(/\b(rep|sen|representative|senator)\.?\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function mergeAlignment(rosterList, alignments) {
  const byId = new Map();
  const byName = new Map();
  alignments.forEach((a) => {
    if (a?.id) byId.set(String(a.id).toLowerCase(), a);
    if (a?.name) byName.set(normalizeName(a.name), a);
  });
  return rosterList.map((member) => {
    const hit = byId.get(String(member.id || '').toLowerCase()) || byName.get(normalizeName(member.name));
    if (!hit) return member;
    return {
      ...member,
      alignment: typeof hit.alignment === 'number' ? hit.alignment : member.alignment,
      votes: hit.votes || member.votes,
      flaggedVotes: hit.flaggedVotes || member.flaggedVotes,
    };
  });
}

function computeStats({ bills, house, senate }) {
  const alignValues = (list) => (list || []).map((m) => (Number.isFinite(m.alignment) ? m.alignment : null)).filter((v) => v !== null);
  const avg = (values) => {
    if (!values.length) return null;
    const sum = values.reduce((a, b) => a + b, 0);
    return sum / values.length;
  };

  const houseAlign = alignValues(house);
  const senateAlign = alignValues(senate);
  const allAlign = [...houseAlign, ...senateAlign];

  return {
    billsTracked: Array.isArray(bills) ? bills.length : 0,
    averageAlignment: avg(allAlign),
    congressAlignment: avg(allAlign),
  };
}

async function fetchRosterRemote() {
  let lastErr = null;
  for (const source of rosterSources) {
    try {
      const res = await fetch(source, {
        headers: { 'user-agent': 'actualapproval.com roster fetch (+https://github.com/actualapproval)' },
      });
      if (!res.ok) throw new Error(`roster fetch failed ${res.status}`);
      const body = await res.json();
      return body;
    } catch (err) {
      lastErr = err;
      console.error('roster source failed', source, err.message || err);
    }
  }
  throw lastErr || new Error('all roster sources failed');
}

async function loadRosterSeed() {
  for (const seed of rosterSeedFiles) {
    const full = path.join(dataDir, seed.name);
    try {
      const raw = await fs.readFile(full, 'utf-8');
      const parsed = seed.type === 'yaml' ? YAML.parse(raw) : JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) {
        return mapRoster(parsed);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`roster seed ${seed.name} failed`, err.message || err);
    }
  }
  return null;
}

function mapRoster(body) {
  const house = new Map();
  const senate = new Map();
  (body || []).forEach((entry) => {
    const lastTerm = entry?.terms?.[entry.terms.length - 1];
    if (!lastTerm) return;
    if (lastTerm.type === 'rep' && !votingStates.has(lastTerm.state)) return;
    const base = {
      id: entry?.id?.bioguide || entry?.id?.govtrack || entry?.id?.icpsr,
      name: entry?.name?.official_full || entry?.name?.first || 'Unknown',
      party: lastTerm.party,
      alignment: null,
      votes: { yes: null, total: null },
    };
    if (lastTerm.type === 'rep') {
      const id = base.id || `${lastTerm.state}-${lastTerm.district ?? 'AL'}`;
      if (!house.has(id)) {
        house.set(id, {
          ...base,
          state: formatDistrictCode(lastTerm.state, lastTerm.district),
          chamber: 'house',
        });
      }
    } else if (lastTerm.type === 'sen') {
      const id = base.id || `${lastTerm.state}-${lastTerm.class || ''}`;
      if (!senate.has(id)) {
        senate.set(id, {
          ...base,
          state: lastTerm.state,
          chamber: 'senate',
        });
      }
    }
  });
  return { house: Array.from(house.values()), senate: Array.from(senate.values()) };
}

async function loadRoster({ houseAlign, senateAlign }) {
  let cached = null;
  let cacheMtime = 0;
  try {
    const stat = await fs.stat(rosterCacheFile);
    cacheMtime = stat.mtimeMs;
    const raw = await fs.readFile(rosterCacheFile, 'utf-8');
    cached = JSON.parse(raw);
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('roster cache read error', err);
  }

  const now = Date.now();
  const cacheFresh = cached && now - cacheMtime < rosterTtlMs;
  let rosterData = cached;

  if (!cacheFresh) {
    rosterData = await loadRosterSeed();
    if (rosterData) {
      try {
        await fs.writeFile(rosterCacheFile, JSON.stringify(rosterData, null, 2));
      } catch (err) {
        console.warn('roster cache write failed', err.message || err);
      }
    } else {
      try {
        const rawRoster = await fetchRosterRemote();
        rosterData = mapRoster(rawRoster);
        await fs.writeFile(rosterCacheFile, JSON.stringify(rosterData, null, 2));
      } catch (err) {
        console.error('roster fetch failed', err);
        if (!rosterData) {
          // Fail soft with whatever alignment rows we have locally
          const house = mergeAlignment(houseAlign || [], houseAlign || []);
          const senate = mergeAlignment(senateAlign || [], senateAlign || []);
          return { house, senate };
        }
      }
    }
  }

  const house = mergeAlignment(rosterData.house || [], houseAlign || []);
  const senate = mergeAlignment(rosterData.senate || [], senateAlign || []);
  return { house, senate };
}

async function loadData() {
  const [bills, president] = await Promise.all([
    readCSV('popular_bills.csv'),
    loadPresident(),
  ]);
  console.log('Loaded bills:', bills.length);

  const liveAlign = await calculateAlignmentFromDatabase();
  const { house, senate } = await loadRoster({ houseAlign: liveAlign.house, senateAlign: liveAlign.senate });

  const normalizeVotes = (list) => list.map((m) => {
    const yes = Number.isFinite(Number(m.votes?.yes)) ? Number(m.votes.yes) : 0;
    const total = Number.isFinite(Number(m.votes?.total)) ? Number(m.votes.total) : 0;
    const safeYes = Math.max(0, yes);
    const safeTotal = Math.max(0, total);
    const alignment = safeTotal > 0 ? safeYes / safeTotal : 0;
    return {
      ...m,
      alignment,
      votes: { yes: safeYes, total: safeTotal },
      flaggedVotes: m.flaggedVotes || [],
    };
  });

  const houseWithVotes = normalizeVotes(house);
  const senateWithVotes = normalizeVotes(senate);
  const stats = computeStats({ bills, house: houseWithVotes, senate: senateWithVotes });
  return { bills, house: houseWithVotes, senate: senateWithVotes, president, stats };
}

app.get('/api/stats', async (_req, res) => {
  try {
    const { stats } = await loadData();
    res.json(stats);
  } catch (err) {
    console.error('stats error', err);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

app.get('/api/president', async (_req, res) => {
  try {
    const { president } = await loadData();
    res.json(president);
  } catch (err) {
    console.error('president error', err);
    res.status(500).json({ error: 'Failed to load president data' });
  }
});

app.get('/api/house', async (_req, res) => {
  try {
    const { house } = await loadData();
    res.json(house);
  } catch (err) {
    console.error('house error', err);
    res.status(500).json({ error: 'Failed to load House data' });
  }
});

app.get('/api/senate', async (_req, res) => {
  try {
    const { senate } = await loadData();
    res.json(senate);
  } catch (err) {
    console.error('senate error', err);
    res.status(500).json({ error: 'Failed to load Senate data' });
  }
});

app.get('/api/bills', async (_req, res) => {
  try {
    const rawBills = await readCSV('popular_bills.csv');
    const bills = rawBills.map(b => ({
      name: b['Bill Title'],
      description: b['Short Description'],
      support_percent: parseInt(b['Public Support %']),
      source: b['Source']
    }));
    res.json(bills);
  } catch (err) {
    console.error('bills error', err);
    res.status(500).json({ error: 'Failed to load bills' });
  }
});

app.get('/api/search', async (req, res) => {
  const name = String(req.query.name || '').trim().substring(0, 100);
  const zip = String(req.query.zip || '').trim().substring(0, 5);
  try {
    const { house, senate, president } = await loadData();
    let houseResults = [...house];
    let senateResults = [...senate];
    const presidentResult = president ? [{ ...president, chamber: 'president' }] : [];

    if (name) {
      const term = name.toLowerCase();
      houseResults = houseResults.filter((m) => (m.name || '').toLowerCase().includes(term));
      senateResults = senateResults.filter((m) => (m.name || '').toLowerCase().includes(term));
      if (!president.name.toLowerCase().includes(term)) presidentResult.length = 0;
    }

    if (zip) {
      if (!/^\d{5}$/.test(zip)) return res.status(400).json({ error: 'ZIP must be 5 digits' });
      const lookup = zipcodes.lookup(zip);
      if (!lookup) return res.status(404).json({ error: 'ZIP not found' });
      const zipState = (lookup.state || '').toUpperCase();
      houseResults = [];
      const withinState = (member) => (member.state || '').toUpperCase().startsWith(zipState);

      // Primary: use local ZIP→district CSV mapping
      const zipDistrictsRaw = (await loadZipDistricts()).get(zip);
      if (zipDistrictsRaw && zipDistrictsRaw.size) {
        // Normalize district codes for comparison (handles GA-5 vs GA-05)
        const zipDistrictsNormalized = new Set([...zipDistrictsRaw].map(normalizeDistrictCode));
        houseResults = house.filter((m) => {
          if (!withinState(m)) return false;
          const memberDistrict = normalizeDistrictCode(m.state || '');
          return zipDistrictsNormalized.has(memberDistrict);
        });
      }

      if (!houseResults.length) return res.status(404).json({ error: 'No district match for that ZIP' });

      if (name) {
        const normInput = normalizeName(name);
        houseResults = houseResults.filter((m) => normalizeName(m.name).includes(normInput));
        if (!houseResults.length) return res.status(404).json({ error: 'No matches for that name and ZIP' });
      }

      senateResults = senateResults.filter((m) => (m.state || '').toUpperCase() === zipState).slice(0, 2);
    }

    if (!houseResults.length && !senateResults.length && !presidentResult.length) {
      return res.status(404).json({ error: 'No matches' });
    }
    res.json({ president: presidentResult, house: houseResults, senate: senateResults });
  } catch (err) {
    console.error('search error', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

app.use((_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.listen(port, () => {
  console.log(`actualapproval.com running on http://localhost:${port}`);
});

