'use strict';
const fetch = require('node-fetch');

const BASE_URL = 'https://circlechart.kr';

// ── Test artist (likely charting right now) ───────────────────────────────────
const TEST_ARTIST = 'aespa';

// ── Week params (ISO week) ────────────────────────────────────────────────────

function getCurrentWeekParams() {
  const now    = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const year   = now.getFullYear();
  // ISO week: Thursday-based
  const thu    = new Date(now);
  thu.setDate(now.getDate() + (4 - (now.getDay() || 7)));
  const yearStart = new Date(thu.getFullYear(), 0, 1);
  const weekNum   = Math.ceil(((thu - yearStart) / 86400000 + 1) / 7);
  const targetTime = String(weekNum).padStart(2, '0');
  return { hitYear: String(year), targetTime, yearTime: '3' };
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────

async function fetchOnoffChart(serviceGbn, params) {
  const body = new URLSearchParams({
    nationGbn:  'T',
    serviceGbn,
    termGbn:    'week',
    hitYear:    params.hitYear,
    targetTime: params.targetTime,
    yearTime:   params.yearTime,
    curUrl:     `circlechart.kr/page_chart/onoff.circle?serviceGbn=${serviceGbn}`,
  });
  const res = await fetch(`${BASE_URL}/data/api/chart/onoff`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer':      `${BASE_URL}/page_chart/onoff.circle`,
      'User-Agent':   'Mozilla/5.0',
    },
    body,
  });
  if (!res.ok) throw new Error(`onoff API ${res.status}`);
  return (await res.json()).List || [];
}

async function fetchAlbumChart(params) {
  const body = new URLSearchParams({
    nationGbn:  'T',
    termGbn:    'week',
    hitYear:    params.hitYear,
    targetTime: params.targetTime,
    yearTime:   params.yearTime,
    curUrl:     'circlechart.kr/page_chart/album.circle',
  });
  const res = await fetch(`${BASE_URL}/data/api/chart/album`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer':      `${BASE_URL}/page_chart/album.circle`,
      'User-Agent':   'Mozilla/5.0',
    },
    body,
  });
  if (!res.ok) throw new Error(`album API ${res.status}`);
  return (await res.json()).List || [];
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const params = getCurrentWeekParams();
  console.log(`Week params: ${JSON.stringify(params)}\n`);

  // ── 1. Digital chart — first 3 entries raw ────────────────────────────────
  console.log('=== DIGITAL CHART (ALL) — first 3 entries raw ===');
  try {
    const list = await fetchOnoffChart('ALL', params);
    console.log(`Total entries: ${list.length}`);
    for (const entry of list.slice(0, 3)) {
      console.log(JSON.stringify(entry, null, 2));
    }

    // Search for test artist
    const found = list.filter(e => (e.ARTIST_NAME || '').toLowerCase().includes(TEST_ARTIST.toLowerCase()));
    console.log(`\n--- "${TEST_ARTIST}" entries (Digital) ---`);
    if (found.length) {
      for (const e of found) console.log(JSON.stringify(e, null, 2));
    } else {
      console.log(`Not found on Digital chart this week.`);
    }
  } catch (e) {
    console.error(`Digital chart error: ${e.message}`);
  }

  await new Promise(r => setTimeout(r, 1500));

  // ── 2. Album chart — first 3 entries raw ─────────────────────────────────
  console.log('\n=== ALBUM CHART — first 3 entries raw ===');
  try {
    const list = await fetchAlbumChart(params);
    console.log(`Total entries: ${list.length}`);
    for (const entry of list.slice(0, 3)) {
      console.log(JSON.stringify(entry, null, 2));
    }

    // Search for test artist
    const found = list.filter(e => (e.ARTIST_NAME || '').toLowerCase().includes(TEST_ARTIST.toLowerCase()));
    console.log(`\n--- "${TEST_ARTIST}" entries (Album) ---`);
    if (found.length) {
      for (const e of found) console.log(JSON.stringify(e, null, 2));
    } else {
      console.log(`Not found on Album chart this week.`);
    }
  } catch (e) {
    console.error(`Album chart error: ${e.message}`);
  }

  // ── 3. All unique field names across both charts ───────────────────────────
  console.log('\n=== FIELD NAME SUMMARY ===');
  try {
    const digital = await fetchOnoffChart('ALL', params);
    const album   = await fetchAlbumChart(params);
    const digitalFields = digital.length ? Object.keys(digital[0]) : [];
    const albumFields   = album.length   ? Object.keys(album[0])   : [];
    console.log('Digital fields:', digitalFields.join(', '));
    console.log('Album fields:  ', albumFields.join(', '));
  } catch (e) {
    console.error(`Field summary error: ${e.message}`);
  }
}

main().catch(console.error);
