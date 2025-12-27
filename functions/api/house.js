import { loadRoster } from './_data.js';

export async function onRequest(context) {
    const { env } = context;
    const KV = env.DATA_KV;

    try {
        const { house } = await loadRoster(KV);
        return new Response(JSON.stringify(house), {
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (err) {
        return new Response(JSON.stringify({ error: 'Failed to load house data' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
