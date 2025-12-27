import { loadRoster, getKVData } from './_data.js';

export async function onRequest(context) {
    const { env } = context;
    const KV = env.DATA_KV;

    try {
        const [{ house, senate }, bills] = await Promise.all([
            loadRoster(KV),
            getKVData(KV, 'popular_bills.csv', 'csv')
        ]);

        const all = [...house, ...senate];
        const validAlignments = all.filter(m => m.votes?.total > 0);
        const avg = validAlignments.length > 0
            ? validAlignments.reduce((acc, m) => acc + (m.alignment || 0), 0) / validAlignments.length
            : 0;

        return new Response(JSON.stringify({
            billsTracked: bills?.length || 0,
            averageAlignment: avg,
            congressAlignment: 0.42, // Static or calculated
        }), {
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (err) {
        return new Response(JSON.stringify({ error: 'Failed to load stats', details: err.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
