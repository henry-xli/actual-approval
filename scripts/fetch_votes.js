const fs = require('node:fs/promises');
const path = require('node:path');
const { XMLParser } = require('fast-xml-parser');
const YAML = require('yaml');

const dataDir = path.join(__dirname, '..', 'data');
const popularBillsFile = path.join(dataDir, 'popular_bills.csv');
const votesFile = path.join(dataDir, 'votes.json');
const legislatorsFile = path.join(dataDir, 'legislators-current.yaml');

async function readCSV(file) {
    const raw = await fs.readFile(file, 'utf-8');
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

async function fetchWithRetry(url, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(url, {
                headers: { 'user-agent': 'actualapproval.com fetcher' }
            });
            if (res.ok) return res;
            if (res.status === 404) return null;
        } catch (e) {
            if (i === retries - 1) throw e;
        }
        await new Promise(r => setTimeout(r, 1000));
    }
    return null;
}

async function run() {
    const bills = await readCSV(popularBillsFile);
    console.log(`Loaded ${bills.length} bills from CSV`);

    let existingVotes = {};
    try {
        const raw = await fs.readFile(votesFile, 'utf-8');
        existingVotes = JSON.parse(raw);
    } catch (e) { }

    const legislatorsRaw = await fs.readFile(legislatorsFile, 'utf-8');
    const legislators = YAML.parse(legislatorsRaw);
    const lisToBioguide = new Map();
    legislators.forEach(l => {
        if (l.id?.lis) lisToBioguide.set(l.id.lis, l.id.bioguide);
    });

    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });

    const billMapping = {
        "H.R. 3617": [{ congress: "117", session: "2", roll_call: "107", chamber: "house" }],
        "H.R. 8281": [{ congress: "118", session: "2", roll_call: "344", chamber: "house" }],
        "S. 4445": [{ congress: "118", session: "2", roll_call: "192", chamber: "senate" }],
        "H.R. 8": [{ congress: "117", session: "1", roll_call: "75", chamber: "house" }],
        "S. 4361": [{ congress: "118", session: "2", roll_call: "182", chamber: "senate" }],
        "H.R. 1280": [{ congress: "117", session: "1", roll_call: "60", chamber: "house" }],
        "S. 2747": [{ congress: "117", session: "1", roll_call: "420", chamber: "senate" }],
        "H.R. 5376": [{ congress: "117", session: "1", roll_call: "385", chamber: "house" }],
        "H.R. 7024": [
            { congress: "118", session: "2", roll_call: "30", chamber: "house" },
            { congress: "118", session: "2", roll_call: "230", chamber: "senate" }
        ],
        "S. 4822": [{ congress: "117", session: "2", roll_call: "346", chamber: "senate" }],
        "H.R. 82": [{ congress: "118", session: "2", roll_call: "461", chamber: "house" }],
        "H.R. 2102": [{ congress: "119", session: "1", roll_call: "15", chamber: "house" }],
        "S. 1115": [{ congress: "119", session: "1", roll_call: "45", chamber: "senate" }],
    };

    for (const bill of bills) {
        const title = bill["Bill Title"];
        const mappings = billMapping[title];
        if (!mappings) {
            console.log(`Skipping ${title} (no mapping found)`);
            continue;
        }

        for (const mapping of mappings) {
            const { congress, chamber, roll_call, session } = mapping;
            const name = title;

            const id = `${congress}-${session}-${roll_call}-${chamber}`;
            if (existingVotes[chamber]?.[id]) {
                console.log(`Already have votes for ${name} (${id})`);
                continue;
            }

            console.log(`Fetching votes for ${name} (${id})...`);
            let positions = {};

            if (chamber.toLowerCase() === 'house') {
                const baseYear = 2021 + (parseInt(congress) - 117) * 2;
                const year = (baseYear + (parseInt(session) - 1)).toString();
                const paddedRoll = roll_call.padStart(3, '0');
                const url = `https://clerk.house.gov/evs/${year}/roll${paddedRoll}.xml`;
                const res = await fetchWithRetry(url);
                if (!res) {
                    console.warn(`Failed to fetch House vote ${id}`);
                    continue;
                }
                const xml = await res.text();
                const data = parser.parse(xml);
                const votes = data['rollcall-vote']?.['vote-data']?.['recorded-vote'] || [];
                console.log(`Found ${Array.isArray(votes) ? votes.length : (votes ? 1 : 0)} votes in XML`);
                (Array.isArray(votes) ? votes : [votes]).forEach(v => {
                    const bioId = v.legislator?.['name-id'];
                    const vote = v.vote;
                    if (bioId) positions[bioId] = vote;
                });
            } else {
                const paddedRoll = roll_call.padStart(5, '0');
                const url = `https://www.senate.gov/legislative/LIS/roll_call_votes/vote${congress}${session}/vote_${congress}_${session}_${paddedRoll}.xml`;
                const res = await fetchWithRetry(url);
                if (!res) {
                    console.warn(`Failed to fetch Senate vote ${id}`);
                    continue;
                }
                const xml = await res.text();
                const data = parser.parse(xml);
                const votes = data.roll_call_vote?.members?.member || [];
                (Array.isArray(votes) ? votes : [votes]).forEach(v => {
                    const lisId = v.lis_member_id;
                    const vote = v.vote_cast;
                    const bioId = lisToBioguide.get(lisId);
                    if (bioId) positions[bioId] = vote;
                    else if (lisId) {
                        // Fallback: use name if bioguide not found in current legislators
                        positions[`LIS:${lisId}`] = vote;
                    }
                });
            }

            if (Object.keys(positions).length > 0) {
                if (!existingVotes[chamber]) existingVotes[chamber] = {};
                existingVotes[chamber][id] = {
                    bill: bill,
                    positions
                };
                await fs.writeFile(votesFile, JSON.stringify(existingVotes, null, 2));
                console.log(`Saved ${Object.keys(positions).length} positions for ${name}`);
            }
        }
    }
}

run().catch(console.error);
