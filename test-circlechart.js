'use strict';
const fetch = require('node-fetch');

const BASE_URL = 'https://circlechart.kr';

async function main() {
  const params = { hitYear: '2026', targetTime: '22', yearTime: '1' };

  console.log('=== RAW DIGITAL RESPONSE (week 22, yearTime 1) ===');
  const digitalBody = new URLSearchParams({
    nationGbn: 'T', serviceGbn: 'ALL', termGbn: 'week',
    hitYear: params.hitYear, targetTime: params.targetTime, yearTime: params.yearTime,
    curUrl: 'circlechart.kr/page_chart/onoff.circle?serviceGbn=ALL',
  });
  const digitalRes = await fetch(`${BASE_URL}/data/api/chart/onoff`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': `${BASE_URL}/page_chart/onoff.circle`, 'User-Agent': 'Mozilla/5.0' },
    body: digitalBody,
  });
  const digitalJson = await digitalRes.json();
  console.log('Keys:', Object.keys(digitalJson));
  console.log('Full response (trimmed):');
  const str = JSON.stringify(digitalJson);
  console.log(str.slice(0, 2000));

  await new Promise(r => setTimeout(r, 1000));

  console.log('\n=== RAW ALBUM RESPONSE (week 22, yearTime 1) ===');
  const albumBody = new URLSearchParams({
    nationGbn: 'T', termGbn: 'week',
    hitYear: params.hitYear, targetTime: params.targetTime, yearTime: params.yearTime,
    curUrl: 'circlechart.kr/page_chart/album.circle',
  });
  const albumRes = await fetch(`${BASE_URL}/data/api/chart/album`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': `${BASE_URL}/page_chart/album.circle`, 'User-Agent': 'Mozilla/5.0' },
    body: albumBody,
  });
  const albumJson = await albumRes.json();
  console.log('Keys:', Object.keys(albumJson));
  console.log('Full response (trimmed):');
  const str2 = JSON.stringify(albumJson);
  console.log(str2.slice(0, 2000));
}

main().catch(console.error);
