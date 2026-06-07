'use strict';

const fetch = require('node-fetch');

// 4 Flowers Spotify track ID
const TEST_TRACK_ID = '3wc2PoPGpb1vzM79AgitIh';
const URL = `https://www.mystreamcount.com/track/${TEST_TRACK_ID}`;

async function test() {
  console.log(`Fetching: ${URL}`);
  const res = await fetch(URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  });
  console.log(`Status: ${res.status}`);
  const html = await res.text();

  // Try to find stream count — appears as plain number near "Total Streams"
  const match = html.match(/Total Streams[\s\S]{0,200}?([\d,]{5,})/);
  if (match) {
    console.log(`✅ Stream count found: ${match[1]}`);
  } else {
    console.log('❌ Could not parse stream count');
    // Dump a snippet to see what we got
    console.log('\n--- HTML snippet (first 500 chars) ---');
    console.log(html.slice(0, 500));
  }
}

test().catch(console.error);
