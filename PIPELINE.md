# Data pipeline stubs (planned)

This static build ships UI only. Wire a backend service to populate real data.

1. Popular policy table (server)

- Inputs: last-4-years bills; polling links (>65% support). Ignore unpopular-pass table for now.
- Action: Call Gemini with prompt to normalize bill name, short description, support %, source URL. Append to CSV/JSON table.
- Storage: `data/popular_bills.csv` (name, description, support_percent, source_link).

2. Congress.gov ingestion (server)

- Pull recent roll call votes for House + Senate.
- Match vote subject/title to popular table using relevance threshold (e.g., cosine/LLM score > 0.6).
- For each member: numerator = yes votes on matched popular bills; denominator = matched bills they voted on; alignment = num/den.
- Persist per-member summary for fast queries: `data/house_alignment.json`, `data/senate_alignment.json`.

3. President metrics (server)

- Executive actions: compile popularity percent for key orders (same format as popular table); compute alignment %.
- Public opinion: live scrape RealClearPolitics / RealClearPolling public pages for President Trump (overall + economy, inflation, immigration when available). No API key required. Cache results in `data/president.json` with TTL (env `PRESIDENT_CACHE_TTL_HOURS`, default 6).
- Combine into `data/president.json` { alignment, approval, issues: { economy, inflation, immigration }, sources, updatedAt }.

4. Legislator roster (server)

- Fetch full current House (435) + Senate (100) roster from the public dataset at `https://theunitedstates.io/congress-legislators/legislators-current.json`.
- Cache to `data/roster.json` with TTL (env `ROSTER_CACHE_TTL_HOURS`, default 12). Merge any locally computed alignment rows onto the roster when present.
- House/Senate endpoints now serve the full roster instead of demo slices.

5. Alignment scoring (server, live optional)

- If `PROPUBLICA_API_KEY` is set, pull recent votes from the ProPublica Congress API for House/Senate (configurable `CONGRESS_NUMBER`, `RECENT_VOTES_LIMIT`).
- Compute alignment = yes/total per member across recent votes; merge with local alignment caches.
- Fail-soft: if ProPublica is unavailable or no API key, endpoints still return cached/local data.

6. API surface (server)

- `GET /api/stats` → { billsTracked, averageAlignment, congressAlignment }
- `GET /api/president`
- `GET /api/house`, `GET /api/senate`
- `GET /api/search?name=...&zip=...` → list of matches with alignment

7. Client wiring (public/app.js)

- Replace demoData with fetches to the endpoints above; map responses into existing render functions.

Keep API keys (Gemini, data providers) in environment variables, not in the repo.
