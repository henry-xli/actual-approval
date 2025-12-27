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
        return Object.fromEntries(headers.map((h, idx) => [h, cols[idx] || '']));
    });
}

export async function loadRoster(KV) {
    const roster = await getKVData(KV, 'roster.json');
    const houseAlign = await getKVData(KV, 'house_alignment_live.json') || [];
    const senateAlign = await getKVData(KV, 'senate_alignment_live.json') || [];

    const merge = (list, aligns) => {
        const alignMap = new Map(aligns.map(a => [a.id, a]));
        return list.map(m => {
            const a = alignMap.get(m.id) || {};
            const yes = Number(a.votes?.yes || 0);
            const total = Number(a.votes?.total || 0);
            return {
                ...m,
                alignment: total > 0 ? yes / total : 0,
                votes: { yes, total },
                flaggedVotes: a.flaggedVotes || []
            };
        });
    };

    return {
        house: merge(roster?.house || [], houseAlign),
        senate: merge(roster?.senate || [], senateAlign)
    };
}
