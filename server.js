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
  fteCsv: 'https://raw.githubusercontent.com/fivethirtyeight/trump-approval-data/master/approval_topline.csv',
  general: 'https://www.realclearpolitics.com/epolls/other/president_trump_job_approval-6179.html',
  economy: 'https://www.realclearpolling.com/polls/approval/donald-trump/issues/economy.html',
  inflation: 'https://www.realclearpolling.com/polls/approval/donald-trump/issues/inflation.html',
  immigration: 'https://www.realclearpolling.com/polls/approval/donald-trump/issues/immigration.html',
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
  const headers = headerLine.split(',');
  return rows
    .map((line) => line.split(','))
    .map((cols) => Object.fromEntries(headers.map((h, idx) => [h, cols[idx]])));
}

async function fetchFteApproval() {
  const res = await fetch(presidentSources.fteCsv, {
    headers: { 'user-agent': 'actualapproval.com scraper (+https://github.com/actualapproval)' },
  });
  if (!res.ok) throw new Error(`fte approval fetch failed ${res.status}`);
  const csv = await res.text();
  const lines = csv.trim().split(/\r?\n/);
  const [headerLine, ...rows] = lines;
  const headers = headerLine.split(',');
  const idx = (name) => headers.indexOf(name);
  const iSubgroup = idx('subgroup');
  const iApprove = idx('approve_estimate');
  const iDate = idx('modeldate');
  if (iSubgroup === -1 || iApprove === -1) throw new Error('fte csv missing columns');
  const parsed = rows
    .map((line) => line.split(','))
    .filter((cols) => (cols[iSubgroup] || '').toLowerCase() === 'all polls')
    .map((cols) => ({
      date: cols[iDate],
      approve: Number.parseFloat(cols[iApprove]),
    }))
    .filter((r) => Number.isFinite(r.approve));
  if (!parsed.length) throw new Error('fte csv empty');
  parsed.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  return parsed[parsed.length - 1].approve / 100;
}

async function scrapeApproval(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'actualapproval.com scraper (+https://github.com/actualapproval)' },
  });
  if (!res.ok) throw new Error(`fetch ${url} failed with ${res.status}`);
  const html = await res.text();
  const approve = extractApprove(html);
  if (approve === null) throw new Error(`could not parse approval from ${url}`);
  return approve;
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
    const offline = { ...seeded, updatedAt: new Date().toISOString() };
    await fs.writeFile(presidentCacheFile, JSON.stringify(offline, null, 2));
    return offline;
  }

  try {
    // Prefer stable CSV from FiveThirtyEight; fall back to HTML scrapes for issues.
    const approval = await fetchFteApproval();
    const [economy, inflation, immigration] = await Promise.all([
      scrapeApproval(presidentSources.economy).catch(() => null),
      scrapeApproval(presidentSources.inflation).catch(() => null),
      scrapeApproval(presidentSources.immigration).catch(() => null),
    ]);
    const president = {
      name: 'Donald J. Trump',
      party: 'R',
      alignment: approval,
      approval,
      issues: { economy, inflation, immigration },
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

async function fetchChamberVotesPropublica(chamber) {
  if (!propublicaKey) return [];
  const url = `https://api.propublica.org/congress/v1/${propublicaCongress}/${chamber}/votes/recent.json`;
  const res = await fetch(url, {
    headers: { 'X-API-Key': propublicaKey, 'user-agent': 'actualapproval.com votes (+https://github.com/actualapproval)' },
  });
  if (!res.ok) throw new Error(`propublica ${chamber} votes ${res.status}`);
  const body = await res.json();
  const votes = body?.results?.votes || [];
  return votes.slice(0, recentVotesLimit);
}

async function fetchCongressGovVotes(chamber) {
  if (!congressGovKey) return [];
  const listUrl = `https://api.congress.gov/v3/roll-call-vote/${propublicaCongress}/${chamber}?api_key=${congressGovKey}`;
  const listRes = await fetch(listUrl, { headers: { 'user-agent': 'actualapproval.com votes (+https://github.com/actualapproval)' } });
  if (listRes.status === 404) return [];
  if (!listRes.ok) throw new Error(`congress.gov list ${chamber} ${listRes.status}`);
  const listBody = await listRes.json();
  const items = listBody?.rollCallVotes || listBody?.results?.votes || [];
  const limited = items.slice(0, recentVotesLimit);
  const detailPromises = limited.map(async (vote) => {
    const number = vote.rollCallNumber || vote.roll_number || vote.number;
    if (!number) return null;
    const detailUrl = `https://api.congress.gov/v3/roll-call-vote/${propublicaCongress}/${chamber}/${number}?api_key=${congressGovKey}`;
    const detailRes = await fetch(detailUrl, { headers: { 'user-agent': 'actualapproval.com votes (+https://github.com/actualapproval)' } });
    if (detailRes.status === 404) return null;
    if (!detailRes.ok) return null;
    const detail = await detailRes.json();
    detail.rollCallNumber = number;
    return detail;
  });
  const details = (await Promise.all(detailPromises)).filter(Boolean);
  return details;
}

function formatDistrictCode(state, district) {
  const distRaw = (district ?? '').toString().trim();
  const dist = distRaw.padStart(2, '0');
  return `${state}-${dist}`.replace(/-0{2}$/, state);
}

// Normalize district codes for comparison (handles GA-5 vs GA-05)
function normalizeDistrictCode(code) {
  const [state, dist] = (code || '').toUpperCase().split('-');
  if (!state) return code.toUpperCase();
  if (!dist) return state; // At-large
  const distNum = parseInt(dist, 10);
  if (Number.isNaN(distNum)) return code.toUpperCase();
  return `${state}-${distNum}`; // Remove leading zeros
}

function parseZipDistrictCsv(text, format = 'auto') {
  const lines = text.trim().split(/\r?\n/);
  const [header, ...rows] = lines;
  const cols = header.split(',').map((c) => c.toLowerCase().trim());
  
  // Detect format: us_districts.csv uses state_abbr,zcta,cd; old format uses zip,state,district
  const isNewFormat = cols.includes('state_abbr') && cols.includes('zcta') && cols.includes('cd');
  
  let iZip, iState, iDistrict;
  if (isNewFormat) {
    iZip = cols.indexOf('zcta');
    iState = cols.indexOf('state_abbr');
    iDistrict = cols.indexOf('cd');
  } else {
    iZip = cols.findIndex((c) => c.includes('zip'));
    iState = cols.findIndex((c) => c === 'state');
    iDistrict = cols.findIndex((c) => c.includes('district'));
  }
  
  if (iZip === -1 || iState === -1 || iDistrict === -1) throw new Error('zip csv missing columns');
  
  const map = new Map();
  rows.forEach((line) => {
    const parts = line.split(',');
    const zip = (parts[iZip] || '').padStart(5, '0');
    const state = (parts[iState] || '').toUpperCase();
    const district = (parts[iDistrict] || '').trim();
    if (!state || !zip) return;
    const code = formatDistrictCode(state, district);
    if (!map.has(zip)) map.set(zip, new Set());
    map.get(zip).add(code.toUpperCase());
  });
  return map;
}

async function loadZipDistricts() {
  if (zipDistrictCache.loaded && zipDistrictCache.map.size) return zipDistrictCache.map;
  const cache = (map) => {
    zipDistrictCache = { loaded: true, map };
    return map;
  };

  // Primary: load from local us_districts.csv (comprehensive ZIP-to-district mapping)
  try {
    const local = await fs.readFile(zipDistrictFile, 'utf-8');
    const map = parseZipDistrictCsv(local);
    console.log(`Loaded ${map.size} ZIP codes from us_districts.csv`);
    return cache(map);
  } catch (err) {
    console.warn('us_districts.csv load failed', err.message || err);
  }

  // Fallback: try old zip-house.csv format
  try {
    const fallback = await fs.readFile(zipDistrictFallbackFile, 'utf-8');
    const map = parseZipDistrictCsv(fallback);
    console.log(`Loaded ${map.size} ZIP codes from fallback zip-house.csv`);
    return cache(map);
  } catch (err) {
    console.warn('zip-house.csv fallback failed', err.message || err);
  }

  return cache(new Map());
}

function tallyVotes(votes) {
  const map = new Map();
  votes.forEach((vote) => {
    const positions = vote?.votes?.vote?.positions || vote?.positions || [];
    positions.forEach((pos) => {
      const id = (pos.memberId || pos.member_id || '').toLowerCase();
      if (!id) return;
      const entry = map.get(id) || {
        id,
        name: `${pos.first_name || pos.firstName || ''} ${pos.last_name || pos.lastName || ''}`.trim(),
        votes: { yes: 0, total: 0 },
        flaggedVotes: [],
      };
      entry.votes.total += 1;
      if (classifyYes(pos.vote_position || pos.voteCast)) entry.votes.yes += 1;
      const question = vote.question || vote.description || vote.voteQuestion || '';
      const date = vote.date || vote.actionDate || '';
      const position = pos.vote_position || pos.voteCast || '';
      entry.flaggedVotes.push({ question, date, position });
      map.set(id, entry);
    });
  });
  return Array.from(map.values()).map((row) => ({
    ...row,
    alignment: row.votes.total ? row.votes.yes / row.votes.total : null,
    flaggedVotes: (row.flaggedVotes || []).slice(0, 3),
  }));
}

async function fetchAlignment() {
  try {
    if (congressGovKey) {
      try {
        const [houseVotes, senateVotes] = await Promise.all([
          fetchCongressGovVotes('house'),
          fetchCongressGovVotes('senate'),
        ]);
        const houseTallied = tallyVotes(houseVotes);
        const senateTallied = tallyVotes(senateVotes);
        if (houseTallied.length || senateTallied.length) {
          return { house: houseTallied, senate: senateTallied };
        }
      } catch (err) {
        console.warn('congress.gov alignment failed, will try fallback', err.message || err);
      }
    }
    if (propublicaKey) {
      try {
        const [houseVotes, senateVotes] = await Promise.all([
          fetchChamberVotesPropublica('house'),
          fetchChamberVotesPropublica('senate'),
        ]);
        return {
          house: tallyVotes(houseVotes),
          senate: tallyVotes(senateVotes),
        };
      } catch (err) {
        console.warn('propublica alignment failed', err.message || err);
      }
    }
  } catch (err) {
    console.error('alignment fetch failed', err);
  }
  return { house: [], senate: [] };
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
  const [bills, houseAlign, senateAlign, president] = await Promise.all([
    readCSV('popular_bills.csv'),
    readJSON('house_alignment.json'),
    readJSON('senate_alignment.json'),
    loadPresident(),
  ]);
  const liveAlign = await fetchAlignment();
  const mergedHouseAlign = [...(houseAlign || []), ...(liveAlign.house || [])];
  const mergedSenateAlign = [...(senateAlign || []), ...(liveAlign.senate || [])];
  const { house, senate } = await loadRoster({ houseAlign: mergedHouseAlign, senateAlign: mergedSenateAlign });
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

app.use(express.static(publicDir));

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
    const bills = await readCSV('popular_bills.csv');
    res.json(bills);
  } catch (err) {
    console.error('bills error', err);
    res.status(500).json({ error: 'Failed to load bills' });
  }
});

app.get('/api/search', async (req, res) => {
  const name = (req.query.name || '').trim();
  const zip = (req.query.zip || '').trim();
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

