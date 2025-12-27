import YAML from 'yaml';

export async function getKVData(KV, key, type = 'json') {
    const raw = await KV.get(key);
    if (!raw) return null;

    if (type === 'json') return JSON.parse(raw);
    if (type === 'yaml') return YAML.parse(raw);
    if (type === 'csv') return parseCSV(raw);
    return raw;
}

function parseCSV(raw) {
    const lines = raw.trim().split(/\r?\n/);
    const [headerLine, ...rows] = lines;
    const headers = headerLine.split(',').map(h => h.trim());
    return rows.map((line) => {
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
        const obj = Object.fromEntries(headers.map((h, idx) => [h, cols[idx] || '']));

        // Map popular_bills.csv headers to frontend keys if they exist
        if (obj['Bill Title'] || obj['Short Description']) {
            return {
                ...obj,
                name: obj.name || obj['Bill Title'],
                description: obj.description || obj['Short Description'],
                support_percent: parseInt(obj.support_percent || obj['Public Support %'] || '0'),
                source: obj.source || obj['Source']
            };
        }
        return obj;
    });
}

export async function loadRoster(KV) {
    const roster = await getKVData(KV, 'roster.json');

    // Load all data sources
    const [votesDb, houseLive, houseStatic, senateLive, senateStatic] = await Promise.all([
        getKVData(KV, 'votes.json'),
        getKVData(KV, 'house_alignment_live.json') || [],
        getKVData(KV, 'house_alignment.json') || [],
        getKVData(KV, 'senate_alignment_live.json') || [],
        getKVData(KV, 'senate_alignment.json') || []
    ]);

    // Calculate alignment from votes.json
    const calculatedAlignments = new Map();
    if (votesDb) {
        const classifyYes = (pos) => {
            const val = (pos || '').toLowerCase();
            return val === 'yes' || val === 'yea' || val === 'aye';
        };

        ['house', 'senate'].forEach(chamber => {
            const chamberVotes = votesDb[chamber] || {};
            for (const voteId in chamberVotes) {
                const vote = chamberVotes[voteId];
                const bill = vote.bill;
                const positions = vote.positions;

                for (const bioId in positions) {
                    const pos = positions[bioId];
                    const id = bioId.toLowerCase();

                    if (!calculatedAlignments.has(id)) {
                        calculatedAlignments.set(id, {
                            id: bioId,
                            votes: { yes: 0, total: 0 },
                            flaggedVotes: []
                        });
                    }

                    const stats = calculatedAlignments.get(id);
                    stats.votes.total += 1;
                    if (classifyYes(pos)) stats.votes.yes += 1;

                    stats.flaggedVotes.push({
                        question: `${bill["Bill Title"]} - ${bill["Short Description"]}`,
                        date: bill["Last Vote Year"],
                        position: pos
                    });
                }
            }
        });
    }

    const merge = (list, live, staticData) => {
        const alignMap = new Map();

        // 1. Start with static data
        (staticData || []).forEach(a => {
            if (a.id) alignMap.set(String(a.id).toLowerCase(), a);
        });

        // 2. Overlay live data (takes precedence)
        (live || []).forEach(a => {
            if (a.id) alignMap.set(String(a.id).toLowerCase(), a);
        });

        // 3. Overlay calculated data from votes.json (highest precedence for accuracy)
        calculatedAlignments.forEach((val, key) => {
            alignMap.set(key, val);
        });

        return list.map(m => {
            const mId = String(m.id || '').toLowerCase();
            const a = alignMap.get(mId) || {};
            const yes = Number(a.votes?.yes || 0);
            const total = Number(a.votes?.total || 0);

            const alignment = total > 0 ? yes / total : (Number(a.alignment) || 0);

            return {
                ...m,
                alignment,
                votes: { yes, total },
                flaggedVotes: a.flaggedVotes || []
            };
        });
    };

    return {
        house: merge(roster?.house || [], houseLive, houseStatic),
        senate: merge(roster?.senate || [], senateLive, senateStatic)
    };
}
