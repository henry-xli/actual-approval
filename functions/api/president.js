export async function onRequest(context) {
    const { env } = context;
    const KV = env.DATA_KV; // Assumes a KV namespace named DATA_KV is bound

    const CACHE_KEY = 'president_data';
    const TTL_HOURS = Number(env.PRESIDENT_CACHE_TTL_HOURS || 6);

    // 1. Try to get from KV
    const cached = await KV.get(CACHE_KEY, { type: 'json' });

    // In Workers, we can use KV's metadata or just store the timestamp inside the JSON
    const now = Date.now();
    const isFresh = cached && cached.updatedAt && (now - new Date(cached.updatedAt).getTime() < TTL_HOURS * 60 * 60 * 1000);

    if (isFresh) {
        return new Response(JSON.stringify(cached), {
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // 2. Fetch fresh data (Simplified version of server.js logic)
    const presidentDataEndpoints = {
        general: 'https://www.realclearpolitics.com/poll/race/8656/polling_data.json',
        economy: 'https://www.realclearpolitics.com/poll/race/8666/polling_data.json',
        inflation: 'https://www.realclearpolitics.com/poll/race/8661/polling_data.json',
        immigration: 'https://www.realclearpolitics.com/poll/race/8659/polling_data.json',
    };

    async function fetchRcp(url) {
        try {
            const res = await fetch(url, {
                headers: { 'user-agent': 'actualapproval.com scraper' }
            });
            const data = await res.json();
            const rcpAvg = data.poll?.find(p => p.type === 'rcp_average');
            const approve = rcpAvg?.candidate?.find(c => c.name === 'Approve');
            return approve ? Number.parseFloat(approve.value) / 100 : null;
        } catch (e) {
            return null;
        }
    }

    const [general, economy, inflation, immigration] = await Promise.all([
        fetchRcp(presidentDataEndpoints.general),
        fetchRcp(presidentDataEndpoints.economy),
        fetchRcp(presidentDataEndpoints.inflation),
        fetchRcp(presidentDataEndpoints.immigration),
    ]);

    const updatedData = {
        name: 'Donald J. Trump',
        party: 'R',
        alignment: general, // Using general approval as alignment for now
        approval: general,
        issues: { economy, inflation, immigration },
        updatedAt: new Date().toISOString(),
    };

    // 3. Save to KV
    await KV.put(CACHE_KEY, JSON.stringify(updatedData));

    return new Response(JSON.stringify(updatedData), {
        headers: { 'Content-Type': 'application/json' }
    });
}
