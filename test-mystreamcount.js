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

  // ── 1. og:description (primary source per plan) ───────────────────────────
  const ogMatch = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)
               || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i);
  if (ogMatch) {
    console.log(`\n✅ og:description found:\n   ${ogMatch[1]}`);
  } else {
    console.log('\n❌ og:description not found');
  }

  // ── 2. Text match fallback ────────────────────────────────────────────────
  const textMatch = html.match(/Total Streams[\s\S]{0,200}?([\d,]{5,})/);
  if (textMatch) {
    console.log(`\n✅ Text match found: ${textMatch[1]}`);
  } else {
    console.log('\n❌ Text match not found');
  }

  // ── 3. All meta tags (for inspection) ────────────────────────────────────
  const metaTags = [...html.matchAll(/<meta[^>]+>/gi)].map(m => m[0]);
  console.log(`\n--- Meta tags found (${metaTags.length}) ---`);
  for (const tag of metaTags) console.log(tag);

  // ── 4. Raw HTML snippet ───────────────────────────────────────────────────
  console.log('\n--- HTML snippet (first 1000 chars) ---');
  console.log(html.slice(0, 1000));
}

test().catch(console.error);
