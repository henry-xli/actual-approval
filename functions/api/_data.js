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
    // Remove UTF-8 BOM if present
    const cleanRaw = raw.replace(/^\uFEFF/, '');
    const lines = cleanRaw.trim().split(/\r?\n/);
    const [headerLine, ...rows] = lines;
    if (!headerLine) return [];

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
        // Check for both exact match and case-insensitive match
        const getVal = (keys) => {
            for (const k of keys) {
                if (obj[k] !== undefined) return obj[k];
                // Case-insensitive check
                const found = Object.keys(obj).find(key => key.toLowerCase() === k.toLowerCase());
                if (found) return obj[found];
            }
            return undefined;
        };

        const billTitle = getVal(['Bill Title', 'name']);
        const billDesc = getVal(['Short Description', 'description']);

        if (billTitle || billDesc) {
            return {
                ...obj,
                name: billTitle,
                description: billDesc,
                support_percent: parseInt(getVal(['Public Support %', 'support_percent']) || '0'),
                source: getVal(['Source', 'source'])
            };
        }
        return obj;
    });
}

export async function loadRoster(KV) {
    const roster = await getKVData(KV, 'roster.json');

    // Load both live and static alignment data
    const [houseLive, houseStatic, senateLive, senateStatic] = await Promise.all([
        getKVData(KV, 'house_alignment_live.json') || [],
        getKVData(KV, 'house_alignment.json') || [],
        getKVData(KV, 'senate_alignment_live.json') || [],
        getKVData(KV, 'senate_alignment.json') || []
    ]);

    const merge = (list, live, staticData) => {
        // Combine live and static alignments, live takes precedence
        const combinedAligns = [...(staticData || []), ...(live || [])];
        const alignMap = new Map();

        combinedAligns.forEach(a => {
            if (!a.id) return;
            const id = String(a.id).toLowerCase();
            // If we already have this ID (from live), don't overwrite with static
            if (!alignMap.has(id) || (a.votes && a.votes.total > 0)) {
                alignMap.set(id, a);
            }
        });

        return list.map(m => {
            const mId = String(m.id || '').toLowerCase();
            const a = alignMap.get(mId) || {};
            const yes = Number(a.votes?.yes || 0);
            const total = Number(a.votes?.total || 0);

            // Fallback to top-level alignment if votes are missing (common in static files)
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
