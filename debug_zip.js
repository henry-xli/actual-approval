
const fs = require('fs');
const path = require('path');

// Mock data from whoismyrepresentative for 95132
const whoIsResponse = {
  results: [
    { name: "Ro Khanna", party: "Democrat", state: "CA", district: "17\n" },
    { name: "Zoe Lofgren", party: "Democrat", state: "CA", district: "19" }
  ]
};

// Mock roster data (subset)
const roster = [
  { name: "Ro Khanna", state: "CA-17", chamber: "house" }, // Assuming padded
  { name: "Zoe Lofgren", state: "CA-19", chamber: "house" },
  { name: "Robert B. Aderholt", state: "AL-04", chamber: "house" } // Assuming padded
];

// The function in server.js
function formatDistrictCode(state, district) {
  const distRaw = (district ?? '').toString().trim();
  const dist = distRaw.padStart(2, '0');
  return `${state}-${dist}`.replace(/-0{2}$/, state);
}

function normalizeName(name) {
  return name
    .toLowerCase()
    .replace(/\b(rep|sen|representative|senator)\.?\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

async function test() {
  console.log("Testing logic...");

  const zip = "95132";
  const zipState = "CA";
  
  // Simulate lookupHouseByZip processing
  const external = whoIsResponse.results.map(r => ({
    name: r.name,
    state: (r.state || '').toUpperCase(),
    district: (r.district || '').toString().trim(),
    party: r.party
  }));

  console.log("External parsed:", external);

  const districtSet = new Set(external.map((e) => formatDistrictCode(e.state, e.district).toUpperCase()));
  console.log("District Set:", Array.from(districtSet));

  // Check matches against roster
  // We need to know what the roster actually looks like.
  // If roster has AL-4 (unpadded), and formatDistrictCode produces AL-04 (padded), we have a mismatch.
  
  const testDist = formatDistrictCode("AL", "4");
  console.log(`formatDistrictCode('AL', '4') = '${testDist}'`);
  
  const testDist17 = formatDistrictCode("CA", "17");
  console.log(`formatDistrictCode('CA', '17') = '${testDist17}'`);

}

test();
