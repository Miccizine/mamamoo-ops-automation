'use strict';

const { getSheetsClient, getSheetData, batchAppendRows, getPHTTimestamp } = require('./helpers');
const fetch = require('node-fetch');

const JITTER_MS = Math.floor(Math.random() * 20000);

const ARTISTS = [
  { key: 'mmm',     label: 'MAMAMOO',  handle: '#MAMAMOO',  kworb: 'https://kworb.net/spotify/artist/0XATRDCYuuGhk0oE7C0o5G.html', url: 'https://open.spotify.com/artist/0XATRDCYuuGhk0oE7C0o5G' },
  { key: 'solar',   label: 'Solar',    handle: '#SOLAR',    kworb: 'https://kworb.net/spotify/artist/5cYcI546S8Lf97m4mNdYLD.html', url: 'https://open.spotify.com/artist/5cYcI546S8Lf97m4mNdYLD' },
  { key: 'moonbyul',label: 'Moonbyul', handle: '#MOONBYUL', kworb: 'https://kworb.net/spotify/artist/1eTft3tXynrKdo6XD7QHLL.html', url: 'https://open.spotify.com/artist/1eTft3tXynrKdo6XD7QHLL' },
  { key: 'wheein',  label: 'Wheein',   handle: '#WHEEIN',   kworb: 'https://kworb.net/spotify/artist/0BqRGrwqndrtNkojXiqIzL.html', url: 'https://open.spotify.com/artist/0BqRGrwqndrtNkojXiqIzL' },
  { key: 'hwasa',   label: 'Hwasa',    handle: '#HWASA',    kworb: 'https://kworb.net/spotify/artist/7bmYpVgQub656uNTu6qGNQ.html', url: 'https://open.spotify.com/artist/7bmYpVgQub656uNTu6qGNQ' },
];

const SHEET = 'Spotify Weekly Tracker';

async function scrapeArtistPage(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function parseFollowersAndStreams(html) {
  // kworb artist page shows: "Followers: 4,304,865" and "Streams: 923,718,052"
  const followMatch   = html.match(/Followers[^0-9]*([0-9,]+)/i);
  const streamsMatch  = html.match(/Streams[^0-9]*([0-9,]+)/i);
  const followers     = followMatch  ? parseInt(followMatch[1].replace(/,/g, ''), 10)  : null;
  const streams       = streamsMatch ? parseInt(streamsMatch[1].replace(/,/g, ''), 10) : null;
  return { followers, streams };
}

function fmt(n) {
  return n != null ? n.toLocaleString('en-US') : 'N/A';
}

function delta(current, prev) {
  if (current == null || prev == null) return '';
  const diff = current - prev;
  return diff >= 0 ? ` (+${fmt(diff)})` : ` (-${fmt(Math.abs(diff))})`;
}

async function sendEmbed(description, title) {
  const webhookUrl = process.env.DISCORD_MILESTONE_WEBHOOK;
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds: [{ title, color: 1947988, description }] }),
  });
  if (res.status === 429) {
    const retry = (await res.json()).retry_after || 2;
    await new Promise(r => setTimeout(r, retry * 1000));
    await sendEmbed(description, title);
  }
}

async function main() {
  console.log(`Starting Spotify weekly updater... (jitter: ${JITTER_MS}ms)`);
  await new Promise(r => setTimeout(r, JITTER_MS));

  const sheets  = await getSheetsClient();
  const history = await getSheetData(sheets, SHEET);

  // Last row = previous week's snapshot (row 0 = headers)
  const lastRow = history.length > 1 ? history[history.length - 1] : null;
  // Column order: Week Of | MMM Followers | MMM Streams | Solar Followers | Solar Streams |
  //               Moonbyul Followers | Moonbyul Streams | Wheein Followers | Wheein Streams |
  //               Hwasa Followers | Hwasa Streams
  const prev = lastRow ? {
    mmm:      { followers: parseInt((lastRow[1]  || '0').replace(/,/g,''), 10), streams: parseInt((lastRow[2]  || '0').replace(/,/g,''), 10) },
    solar:    { followers: parseInt((lastRow[3]  || '0').replace(/,/g,''), 10), streams: parseInt((lastRow[4]  || '0').replace(/,/g,''), 10) },
    moonbyul: { followers: parseInt((lastRow[5]  || '0').replace(/,/g,''), 10), streams: parseInt((lastRow[6]  || '0').replace(/,/g,''), 10) },
    wheein:   { followers: parseInt((lastRow[7]  || '0').replace(/,/g,''), 10), streams: parseInt((lastRow[8]  || '0').replace(/,/g,''), 10) },
    hwasa:    { followers: parseInt((lastRow[9]  || '0').replace(/,/g,''), 10), streams: parseInt((lastRow[10] || '0').replace(/,/g,''), 10) },
  } : null;

  // Scrape all 5 artist pages
  const current = {};
  for (const artist of ARTISTS) {
    console.log(`Scraping ${artist.label}...`);
    const html = await scrapeArtistPage(artist.kworb);
    const { followers, streams } = parseFollowersAndStreams(html);
    current[artist.key] = { followers, streams };
    console.log(`  Followers: ${fmt(followers)} | Streams: ${fmt(streams)}`);
    await new Promise(r => setTimeout(r, 2000));
  }

  const mmm      = current.mmm;
  const prevMmm  = prev?.mmm;

  // ── Post 1: Group followers + total streams ──
  const post1 = [
    `#MAMAMOO Spotify - Weekly Update`,
    `Followers: ${fmt(mmm.followers)}${delta(mmm.followers, prevMmm?.followers)}`,
    `Total Streams Across All Credits: ${fmt(mmm.streams)}${delta(mmm.streams, prevMmm?.streams)}`,
    `https://open.spotify.com/artist/0XATRDCYuuGhk0oE7C0o5G`,
    `#마마무 #ママム @RBW_MAMAMOO`,
  ].join('\n');

  // ── Post 2: Member followers ──
  const memberLines2 = ARTISTS.slice(1).map(a => {
    const c = current[a.key];
    const p = prev?.[a.key];
    return `${a.handle}: ${fmt(c.followers)}${delta(c.followers, p?.followers)}\n${a.url}`;
  }).join('\n');
  const post2 = `#MAMAMOO Members' Spotify Followers - Weekly Update\n${memberLines2}\n#마마무 #ママム @RBW_MAMAMOO`;

  // ── Post 3: Member total streams ──
  const memberLines3 = ARTISTS.slice(1).map(a => {
    const c = current[a.key];
    const p = prev?.[a.key];
    return `${a.handle}: ${fmt(c.streams)}${delta(c.streams, p?.streams)}`;
  }).join('\n');
  const post3 = `#MAMAMOO Members' Total Spotify Streams (across all credits) - Weekly Update\n${memberLines3}\n#마마무 #ママム\n@RBW_MAMAMOO @WheeIn_0fficial`;

  await sendEmbed(post1, 'Spotify Weekly Update');
  await new Promise(r => setTimeout(r, 2000));
  await sendEmbed(post2, 'Spotify Weekly Update');
  await new Promise(r => setTimeout(r, 2000));
  await sendEmbed(post3, 'Spotify Weekly Update');

  // ── Append to Sheet 15 ──
  const weekOf = getPHTTimestamp().split(' ')[0]; // date only
  await batchAppendRows(sheets, SHEET, [[
    weekOf,
    mmm.followers,      mmm.streams,
    current.solar.followers,    current.solar.streams,
    current.moonbyul.followers, current.moonbyul.streams,
    current.wheein.followers,   current.wheein.streams,
    current.hwasa.followers,    current.hwasa.streams,
  ]]);

  console.log('Spotify weekly updater complete.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
