// No require needed for fetch in Node 18+

const congressGovKey = 'n7qBfUJaMBGTHCawf1taYJsn0nDjT7NwdGOx66HH';
const propublicaCongress = 118;
const recentVotesLimit = 2; // Small limit for debug

async function fetchCongressGovVotes(chamber) {
    console.log(`Fetching ${chamber} votes...`);
    if (!congressGovKey) {
        console.log('No API Key');
        return [];
    }
    const endpoint = chamber === 'house' ? 'house-vote' : 'senate-vote';
    const listUrl = `https://api.congress.gov/v3/${endpoint}/${propublicaCongress}?api_key=${congressGovKey}&format=json`;
    console.log(`List URL: ${listUrl}`);

    const listRes = await fetch(listUrl);
    if (!listRes.ok) {
        console.log(`List fetch failed: ${listRes.status} ${listRes.statusText}`);
        const text = await listRes.text();
        console.log(text);
        return [];
    }

    const listBody = await listRes.json();
    console.log('List Body:', JSON.stringify(listBody, null, 2).slice(0, 1000));
    // console.log('List Body keys:', Object.keys(listBody));

    const items = listBody?.houseRollCallVotes || listBody?.senateRollCallVotes || listBody?.rollCallVotes || listBody?.results?.votes || [];
    console.log(`Found ${items.length} votes in list`);

    const limited = items.slice(0, recentVotesLimit);

    const detailPromises = limited.map(async (vote) => {
        const number = vote.rollCallNumber || vote.roll_number || vote.number;
        if (!number) {
            console.log('No roll call number found for vote', vote);
            return null;
        }
        // Use provided URL if available, otherwise construct it (fallback)
        let detailUrl = vote.url;
        if (!detailUrl) {
            detailUrl = `https://api.congress.gov/v3/${endpoint}/${propublicaCongress}/${vote.sessionNumber || 1}/${number}`;
        }

        const metaUrl = detailUrl + `?api_key=${congressGovKey}&format=json`;
        console.log(`Meta URL: ${metaUrl}`);
        const metaRes = await fetch(metaUrl);
        if (!metaRes.ok) {
            console.log(`Meta fetch failed for ${number}: ${metaRes.status}`);
            return null;
        }
        const meta = await metaRes.json();

        const membersUrl = detailUrl + `/members?api_key=${congressGovKey}&format=json`;
        console.log(`Members URL: ${membersUrl}`);
        const membersRes = await fetch(membersUrl);
        if (!membersRes.ok) {
            console.log(`Members fetch failed for ${number}: ${membersRes.status}`);
            return null;
        }
        const membersData = await membersRes.json();

        // Combine
        const combined = { ...meta };
        // Add members to a standard 'positions' property
        const memberContainer = membersData.houseRollCallVoteMemberVotes || membersData.senateRollCallVoteMemberVotes;
        combined.positions = memberContainer?.members || memberContainer?.results || [];

        // Also ensure we have the question/date from meta
        const metaContainer = meta.houseRollCallVote || meta.senateRollCallVote;
        combined.question = metaContainer?.voteQuestion;
        combined.date = metaContainer?.startDate || metaContainer?.actionDate;

        combined.rollCallNumber = number;
        return combined;
    });

    const details = (await Promise.all(detailPromises)).filter(Boolean);
    return details;
}

function classifyYes(position) {
    const val = (position || '').toLowerCase();
    return val === 'yes' || val === 'yea' || val === 'aye';
}

function tallyVotes(votes) {
    console.log(`Tallying ${votes.length} votes...`);
    const map = new Map();
    votes.forEach((vote, idx) => {
        // Debug structure
        // console.log(`Vote ${idx} keys:`, Object.keys(vote));
        if (vote.rollCallVote) {
            // console.log(`Vote ${idx} rollCallVote keys:`, Object.keys(vote.rollCallVote));
        }

        // Try to find positions
        // Structure might be vote.rollCallVote.votePositions
        const positions = vote?.votes?.vote?.positions || vote?.positions || vote?.rollCallVote?.votePositions || [];

        console.log(`Vote ${idx} has ${positions.length} positions`);

        if (positions.length === 0) {
            console.log('Vote structure dump:', JSON.stringify(vote, null, 2).slice(0, 500));
        }

        positions.forEach((pos) => {
            const id = (pos.memberId || pos.member_id || pos.member?.bioguideId || '').toLowerCase();
            if (!id) return;

            const entry = map.get(id) || {
                id,
                name: `${pos.first_name || pos.firstName || ''} ${pos.last_name || pos.lastName || ''}`.trim(),
                votes: { yes: 0, total: 0 },
                flaggedVotes: [],
            };

            entry.votes.total += 1;
            if (classifyYes(pos.vote_position || pos.voteCast || pos.vote)) entry.votes.yes += 1;

            const question = vote.question || vote.description || vote.voteQuestion || vote.rollCallVote?.voteQuestion || '';
            const date = vote.date || vote.actionDate || vote.rollCallVote?.actionDate || '';
            const position = pos.vote_position || pos.voteCast || pos.vote || '';

            entry.flaggedVotes.push({ question, date, position });
            map.set(id, entry);
        });
    });

    return Array.from(map.values());
}

async function run() {
    const houseVotes = await fetchCongressGovVotes('house');
    const houseTallied = tallyVotes(houseVotes);
    console.log(`Tallied ${houseTallied.length} members`);
    if (houseTallied.length > 0) {
        console.log('Sample member:', JSON.stringify(houseTallied[0], null, 2));
    }
}

run();
