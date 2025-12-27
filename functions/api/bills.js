import { getKVData } from './_data.js';

export async function onRequest(context) {
  const { env } = context;
  const KV = env.DATA_KV;

  try {
    const bills = await getKVData(KV, 'popular_bills.csv', 'csv');
    return new Response(JSON.stringify(bills || []), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Failed to load bills' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
