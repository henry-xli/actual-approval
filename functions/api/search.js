import { loadRoster, getKVData } from './_data.js';

export async function onRequest(context) {
    const { request, env } = context;
    const KV = env.DATA_KV;
    const url = new URL(request.url);
    const name = (url.searchParams.get('name') || '').trim().substring(0, 100);
    const zip = (url.searchParams.get('zip') || '').trim().substring(0, 5);

    try {
        const [{ house, senate }, president] = await Promise.all([
            loadRoster(KV),
            getKVData(KV, 'president_data') // Cached by president.js function
        ]);

        let houseResults = [...house];
        let senateResults = [...senate];
        const presidentResult = president ? [{ ...president, chamber: 'president' }] : [];

        if (name) {
            const term = name.toLowerCase();
            houseResults = houseResults.filter((m) => (m.name || '').toLowerCase().includes(term));
            senateResults = senateResults.filter((m) => (m.name || '').toLowerCase().includes(term));
            if (president && !president.name.toLowerCase().includes(term)) {
                presidentResult.length = 0;
            }
        }

        if (zip) {
            if (!/^\d{5}$/.test(zip)) {
                return new Response(JSON.stringify({ error: 'ZIP must be 5 digits' }), { status: 400 });
            }

            // Load ZIP to district mapping from KV
            const zipDistrictsRaw = await getKVData(KV, 'us_districts.csv', 'csv');
            const zipMatch = zipDistrictsRaw?.filter(row => row.zcta === zip);

            if (!zipMatch || zipMatch.length === 0) {
                return new Response(JSON.stringify({ error: 'ZIP not found' }), { status: 404 });
            }

            const zipState = zipMatch[0].state_abbr.toUpperCase();
            const targetDistricts = new Set(zipMatch.map(row => {
                const cd = row.cd;
                if (cd === '0' || cd === '00' || cd === 'AL') return `${zipState}-AL`;
                return `${zipState}-${String(cd).padStart(2, '0')}`;
            }));

            houseResults = house.filter((m) => {
                const memberState = (m.state || '').split('-')[0];
                if (memberState !== zipState) return false;

                // Normalize member state/district for comparison
                const parts = (m.state || '').split('-');
                const dist = parts[1] === 'AL' ? 'AL' : String(parts[1] || '').padStart(2, '0');
                const normalized = `${parts[0]}-${dist}`;

                return targetDistricts.has(normalized);
            });

            senateResults = senate.filter((m) => (m.state || '').toUpperCase() === zipState).slice(0, 2);
        }

        if (!houseResults.length && !senateResults.length && !presidentResult.length) {
            return new Response(JSON.stringify({ error: 'No matches' }), { status: 404 });
        }

        return new Response(JSON.stringify({
            president: presidentResult,
            house: houseResults,
            senate: senateResults
        }), {
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (err) {
        return new Response(JSON.stringify({ error: 'Search failed', details: err.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
