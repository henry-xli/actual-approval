import { loadRoster } from './_data.js';

export async function onRequest(context) {
  const { env } = context;
  const KV = env.DATA_KV;

  try {
    const { senate } = await loadRoster(KV);
    return new Response(JSON.stringify(senate), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Failed to load senate data' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
