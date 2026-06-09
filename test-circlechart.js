'use strict';
const fetch = require('node-fetch');

const BASE_URL   = 'https://circlechart.kr';
const TEST_ARTIST = 'aespa';

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

async function tryWeek(targetTime, yearTime) {
  const params = { hitYear: '2026', targetTime: String(targetTime).padStart(2, '0'), yearTime: String(yearTime) };
  console.log(`\n--- Trying week ${params.targetTime} yearTime=${yearTime} ---`);
  try {
    const digital = await fetchOnoffChart('ALL', params);
    const album   = await fetchAlbumChart(params);
    console.log(`  Digital: ${digital.length} entries | Album: ${album.length} entries`);
    if (digital.length > 0) {
      console.log('  Digital sample:', JSON.stringify(digital[0], null, 2));
      const found = digital.filter(e => (e.ARTIST_NAME || '').toLowerCase().includes(TEST_ARTIST));
      if (found.length) console.log(`  ✅ "${TEST_ARTIST}" found on Digital`);
    }
    if (album.length > 0) {
      console.log('  Album sample:', JSON.stringify(album[0], null, 2));
    }
    return digital.length > 0 || album.length > 0;
  } catch (e) {
    console.log(`  Error: ${e.message}`);
    return false;
  }
}

async function main() {
  console.log('Testing Circle Chart API with different week/yearTime params...\n');

  // Try weeks 21-24, yearTime 1-4
  for (const yearTime of [1, 2, 3, 4]) {
    for (const week of [21, 22, 23, 24]) {
      const hasData = await tryWeek(week, yearTime);
      await new Promise(r => setTimeout(r, 800));
      if (hasData) {
        console.log(`\n✅ Found data: week=${week} yearTime=${yearTime}`);
        return; // stop on first hit
      }
    }
  }
  console.log('\n❌ No data found across all tested params.');
}

main().catch(console.error);
