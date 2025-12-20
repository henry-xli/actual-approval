const routes = Array.from(document.querySelectorAll('.route'));
const navButtons = Array.from(document.querySelectorAll('.bottom-nav button'));
const themeToggle = document.getElementById('theme-toggle');
const searchForm = document.getElementById('search-form');
const searchError = document.getElementById('search-error');
const brandButton = document.querySelector('.logo-button');
const statBills = document.getElementById('stat-bills');
const statAlignment = document.getElementById('stat-alignment');
const statCongress = document.getElementById('stat-congress');
const statReps = document.getElementById('stat-reps');
const houseGrid = document.getElementById('house-grid');
const senateGrid = document.getElementById('senate-grid');
const houseSearchForm = document.getElementById('house-search');
const senateSearchForm = document.getElementById('senate-search');
const houseParty = document.getElementById('house-party');
const senateParty = document.getElementById('senate-party');
const houseSort = document.getElementById('house-sort');
const senateSort = document.getElementById('senate-sort');
const houseCount = document.getElementById('house-count');
const senateCount = document.getElementById('senate-count');
const resultsPresident = document.getElementById('results-president');
const resultsHouse = document.getElementById('results-house');
const resultsSenate = document.getElementById('results-senate');
const resultsHouseCount = document.getElementById('results-house-count');
const resultsSenateCount = document.getElementById('results-senate-count');
const presidentFields = {
    name: document.getElementById('president-name'),
    party: document.getElementById('president-party'),
    score: document.getElementById('president-score'),
    keyvotes: document.getElementById('president-keyvotes'),
    issue: document.getElementById('president-issue'),
    economy: document.getElementById('president-economy'),
    inflation: document.getElementById('president-inflation'),
    immigration: document.getElementById('president-immigration'),
    approval: document.getElementById('president-approval'),
    sources: document.getElementById('president-sources'),
};

const state = {
    stats: { billsTracked: '—', averageAlignment: '—', congressAlignment: '—' },
    president: null,
    house: [],
    senate: [],
    searchResults: { president: [], house: [], senate: [] },
    filters: {
        house: { party: 'all', sort: 'name' },
        senate: { party: 'all', sort: 'name' },
    },
};

let lastThemeSwitch = 0;
document.body.dataset.pageRoute = 'home';

const sorters = {
    name: (a, b) => (a.name || '').localeCompare(b.name || ''),
    'align-desc': (a, b) => (b.alignment ?? -1) - (a.alignment ?? -1) || (a.name || '').localeCompare(b.name || ''),
    'align-asc': (a, b) => (a.alignment ?? 1) - (b.alignment ?? 1) || (a.name || '').localeCompare(b.name || ''),
};

async function fetchJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed ${url}: ${res.status}`);
    return res.json();
}

function setTheme(choice) {
    const root = document.documentElement;
    const theme = choice === 'system'
        ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
        : choice;
    root.dataset.theme = theme;
    localStorage.setItem('aa-theme', choice);
    themeToggle.checked = theme === 'dark';
}

function restoreTheme() {
    const saved = localStorage.getItem('aa-theme');
    const start = saved || 'system';
    setTheme(start);
}
themeToggle.addEventListener('change', (e) => {
    const now = Date.now();
    if (now - lastThemeSwitch < 1000) {
        // Revert toggle to current theme if throttled
        themeToggle.checked = document.documentElement.dataset.theme === 'dark';
        return;
    }
    lastThemeSwitch = now;
    setTheme(e.target.checked ? 'dark' : 'light');
});

navButtons.forEach((btn) => {
    btn.addEventListener('click', () => switchRoute(btn.dataset.nav));
});
if (brandButton) {
    brandButton.addEventListener('click', () => switchRoute('home'));
}

function switchRoute(route) {
    routes.forEach((r) => r.classList.toggle('active', r.dataset.route === route));
    navButtons.forEach((b) => b.classList.toggle('active', b.dataset.nav === route));
    document.body.dataset.pageRoute = route;
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

searchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = document.getElementById('input-name').value.trim();
    const zip = document.getElementById('input-zip').value.trim();
    handleSearch(name, zip);
});

function renderStats() {
    statBills.textContent = state.stats.billsTracked ?? '—';
    const pct = (n) => (typeof n === 'number' ? `${Math.round(n * 100)}%` : '—');
    statAlignment.textContent = pct(state.stats.averageAlignment);
    if (statCongress) statCongress.textContent = pct(state.stats.congressAlignment);
    if (statReps) statReps.textContent = 'Live data';
    const statBillsDup = document.getElementById('stat-bills-dup');
    const statAlignDup = document.getElementById('stat-alignment-dup');
    if (statBillsDup) statBillsDup.textContent = state.stats.billsTracked ?? '—';
    if (statAlignDup) statAlignDup.textContent = pct(state.stats.averageAlignment);
}

function renderPresident() {
    const p = state.president;
    if (!p) {
        presidentFields.name.textContent = 'Loading…';
        return;
    }
    const pct = (n) => (typeof n === 'number' ? `${Math.round(n * 100)}%` : '—');
    presidentFields.name.textContent = p.name;
    if (p.party) {
        const partyClass = p.party === 'D' ? 'party-d' : p.party === 'R' ? 'party-r' : 'party-i';
        presidentFields.party.textContent = p.party;
        presidentFields.party.className = `party-badge ${partyClass}`;
    }
    presidentFields.score.textContent = pct(p.alignment);
    presidentFields.keyvotes.textContent = `${p.votes?.yes ?? '—'}/${p.votes?.total ?? '—'} executive orders`;
    presidentFields.economy.textContent = pct(p.issues?.economy);
    presidentFields.inflation.textContent = pct(p.issues?.inflation);
    presidentFields.immigration.textContent = pct(p.issues?.immigration);
    presidentFields.approval.textContent = pct(p.approval);
    presidentFields.issue.textContent = 'Economy • Inflation • Immigration';
    presidentFields.sources.textContent = p.sources ? `Sources: ${p.sources.join(', ')}` : '';
}

function renderMembers(list, target) {
    target.innerHTML = '';
    const pct = (n) => (typeof n === 'number' ? `${Math.round(n * 100)}%` : '—');
    const partyClassFor = (party) => {
        const p = (party || '').toUpperCase();
        if (p.startsWith('D')) return 'party-d';
        if (p.startsWith('R')) return 'party-r';
        return 'party-i';
    };
    list.forEach((m) => {
        const card = document.createElement('div');
        card.className = 'member-card';
        const partyClass = partyClassFor(m.party);
        const flagged = Array.isArray(m.flaggedVotes) ? m.flaggedVotes.slice(0, 3) : [];
        card.innerHTML = `
      <div class="member-header">
        <div>
          <div class="member-name">${m.name}</div>
                    <div class="member-role">${m.state}</div>
                    <div class="party-badge ${partyClass}">${m.party || '—'}</div>
        </div>
                <div class="align-block">
                    <div class="align-label">Alignment</div>
                    <div class="align-score">${pct(m.alignment)}</div>
                    <div class="key-votes">${m.votes?.yes ?? '—'}/${m.votes?.total ?? '—'} key votes</div>
                </div>
      </div>
                ${flagged.length ? `<div class="recent-votes-label">Recent votes</div><ul class="flagged-list">${flagged.map((v) => `<li>${v.date || ''} ${v.question || ''} – ${v.position || ''}</li>`).join('')}</ul>` : ''}
    `;
        target.appendChild(card);
    });
}

function applyFilters(list, scope) {
    const { party, sort } = state.filters[scope];
    const filtered = list.filter((m) => {
        const partyOk = party === 'all' ? true : (m.party || '').toUpperCase().startsWith(party);
        return partyOk;
    });
    const sorter = sorters[sort] || sorters.name;
    return [...filtered].sort(sorter);
}

function updateFilters(scope) {
    const srcParty = scope === 'house' ? houseParty : senateParty;
    const srcSort = scope === 'house' ? houseSort : senateSort;
    state.filters[scope] = {
        party: srcParty.value,
        sort: srcSort.value,
    };
    renderSection(scope);
}

function renderSection(scope, overrideList) {
    const list = overrideList || (scope === 'house' ? state.house : state.senate);
    const filtered = applyFilters(list, scope);
    const target = scope === 'house' ? houseGrid : senateGrid;
    const count = scope === 'house' ? houseCount : senateCount;
    renderMembers(filtered, target);
    if (count) count.textContent = `Showing ${filtered.length} of ${list.length} entries`;
}

async function loadData() {
    try {
        const [stats, president, house, senate] = await Promise.all([
            fetchJSON('/api/stats'),
            fetchJSON('/api/president'),
            fetchJSON('/api/house'),
            fetchJSON('/api/senate'),
        ]);
        state.stats = stats;
        state.president = president;
        state.house = house;
        state.senate = senate;
        renderStats();
        renderPresident();
        renderSection('house');
        renderSection('senate');
    } catch (err) {
        console.error('Failed to load data', err);
    }
}

async function handleSearch(name, zip) {
    try {
        const params = new URLSearchParams();
        if (name) params.set('name', name);
        if (zip) params.set('zip', zip);
        const data = await fetchJSON(`/api/search?${params.toString()}`);
        searchError.textContent = '';
        state.searchResults = data;
        renderResults();
        switchRoute('results');
    } catch (err) {
        console.error('Search failed', err);
        searchError.textContent = 'No matches for that name or ZIP.';
    }
}

async function handleScopedSearch(scope, name, zip) {
    try {
        const params = new URLSearchParams();
        if (name) params.set('name', name);
        if (zip) params.set('zip', zip);
        const data = await fetchJSON(`/api/search?${params.toString()}`);
        if (scope === 'house') {
            state.filters.house.sort = 'name';
            renderSection('house', data.house || []);
        } else if (scope === 'senate') {
            state.filters.senate.sort = 'name';
            renderSection('senate', data.senate || []);
        }
    } catch (err) {
        console.error('Scoped search failed', err);
        // Silent fail; leave current list
    }
}

function renderResults() {
    const { president, house, senate } = state.searchResults;
    resultsPresident.innerHTML = '';
    if (president && president.length) {
        const p = president[0];
        const pct = (n) => (typeof n === 'number' ? `${Math.round(n * 100)}%` : '—');
        const badgeClass = p.party === 'D' ? 'party-d' : p.party === 'R' ? 'party-r' : 'party-i';
        const card = document.createElement('div');
        card.className = 'member-card president-like';
        card.innerHTML = `
                    <div class="member-header">
                        <div>
                            <div class="member-name">${p.name}</div>
                            <div class="member-role">US</div>
                            <div class="party-badge ${badgeClass}">${p.party || '—'}</div>
                        </div>
                        <div class="align-block">
                            <div class="align-label">Alignment</div>
                            <div class="align-score">${pct(p.alignment)}</div>
                            <div class="key-votes">${p.issues ? `${p.issues.economy ? pct(p.issues.economy) + ' economy' : ''}` : ''}</div>
                            <div class="key-votes">${p.approval ? `${pct(p.approval)} approval` : 'Approval n/a'}</div>
                        </div>
                    </div>
                    <div class="flagged-list">
                        ${['economy', 'inflation', 'immigration'].map((k) => `<div>${k}: ${pct(p.issues?.[k])}</div>`).join('')}
                    </div>
                `;
        resultsPresident.appendChild(card);
    } else {
        resultsPresident.textContent = 'No match.';
    }

    resultsHouseCount.textContent = `Showing ${house?.length || 0} matches`;
    resultsSenateCount.textContent = `Showing ${senate?.length || 0} matches`;
    renderMembers(house || [], resultsHouse);
    renderMembers(senate || [], resultsSenate);
}

function init() {
    restoreTheme();
    renderStats();
    renderPresident();
    loadData();

    houseParty.addEventListener('change', () => updateFilters('house'));
    senateParty.addEventListener('change', () => updateFilters('senate'));
    houseSort.addEventListener('change', () => updateFilters('house'));
    senateSort.addEventListener('change', () => updateFilters('senate'));
    houseSearchForm?.addEventListener('submit', (e) => {
        e.preventDefault();
        const name = document.getElementById('house-input-name').value.trim();
        const zip = document.getElementById('house-input-zip').value.trim();
        handleScopedSearch('house', name, zip);
    });
    senateSearchForm?.addEventListener('submit', (e) => {
        e.preventDefault();
        const name = document.getElementById('senate-input-name').value.trim();
        const zip = document.getElementById('senate-input-zip').value.trim();
        handleScopedSearch('senate', name, zip);
    });
    renderSection('house');
    renderSection('senate');
}

init();
