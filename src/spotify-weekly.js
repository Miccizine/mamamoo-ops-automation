'use strict';

const { getSheetsClient, getSheetData, batchAppendRows, getPHTTimestamp } = require('./helpers');
const fetch = require('node-fetch');

const JITTER_MS = Math.floor(Math.random() * 20000);

const ARTISTS = [
  {
    key: 'mmm',      label: 'MAMAMOO',  handle: '#MAMAMOO',
    id:  '0XATRDCYuuGhk0oE7C0o5G',
    url: 'https://open.spotify.com/artist/0XATRDCYuuGhk0oE7C0o5G?si=TH9gYHEORCOxf_Vb_Jto1Q',
    kworb: 'https://kworb.net/spotify/artist/0XATRDCYuuGhk0oE7C0o5G_songs.html',
  },
  {
    key: 'solar',    label: 'Solar',    handle: '#SOLAR',
    id:  '5cYcI546S8Lf97m4mNdYLD',
    url: 'https://open.spotify.com/artist/5cYcI546S8Lf97m4mNdYLD?si=X-tySw9cTP-lQk3FWD7zXA',
    kworb: 'https://kworb.net/spotify/artist/5cYcI546S8Lf97m4mNdYLD_songs.html',
  },
  {
    key: 'moonbyul', label: 'Moonbyul', handle: '#MOONBYUL',
    id:  '1eTft3tXynrKdo6XD7QHLL',
    url: 'https://open.spotify.com/artist/1eTft3tXynrKdo6XD7QHLL?si=CeeeoIztRmmsLLoR4kh_tQ',
    kworb: 'https://kworb.net/spotify/artist/1eTft3tXynrKdo6XD7QHLL_songs.html',
  },
  {
    key: 'wheein',   label: 'Wheein',   handle: '#WHEEIN',
    id:  '0BqRGrwqndrtNkojXiqIzL',
    url: 'https://open.spotify.com/artist/0BqRGrwqndrtNkojXiqIzL?si=V4Ao0XTUSUalE5L6ulx4yg',
    kworb: 'https://kworb.net/spotify/artist/0BqRGrwqndrtNkojXiqIzL_songs.html',
  },
  {
    key: 'hwasa',    label: 'Hwasa',    handle: '#HWASA',
    id:  '7bmYpVgQub656uNTu6qGNQ',
    url: 'https://open.spotify.com/artist/7bmYpVgQub656uNTu6qGNQ?si=2nk0g6DLSiSDfefpY1cVFA',
    kworb: 'https://kworb.net/spotify/artist/7bmYpVgQub656uNTu6qGNQ_songs.html',
  },
];

const SHEET = 'Spotify Weekly Tracker';

// ── Spotify Auth ──────────────────────────────────────────────────────────────

async function getSpotifyToken() {
  const creds = Buffer.from(
    `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
  ).toString('base64');

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`Spotify auth failed: ${res.status}`);
  const data = await res.json();
  return data.access_token;
}

async function getSpotifyFollowers(token, artistId) {
  const res = await fetch(`https://api.spotify.com/v1/artists/${artistId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Spotify API error: ${res.status} for ${artistId}`);
  const data = await res.json();
  return data.followers.total;
}

// ── Kworb total streams ───────────────────────────────────────────────────────

async function scrapeTotalStreams(kworbUrl) {
  const res = await fetch(kworbUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${kworbUrl}`);
  const html = await res.text();

  const m = html.match(/Streams<\/td>\s*<td[^>]*>([\d,]+)/);
  if (!m) throw new Error(`Could not parse total streams from ${kworbUrl}`);
  return parseInt(m[1].replace(/,/g, ''), 10);
}

// ── Formatting ────────────────────────────────────────────────────────────────

function fmt(n) {
  return n != null ? n.toLocaleString('en-US') : 'N/A';
}

function delta(current, prev) {
  if (current == null || prev == null || prev === 0) return '';
  const diff = current - prev;
  return diff >= 0 ? `(+${fmt(diff)})` : `(-${fmt(Math.abs(diff))})`;
}

// ── Discord ───────────────────────────────────────────────────────────────────

async function sendEmbed(description, title) {
  const res = await fetch(process.env.DISCORD_MILESTONE_WEBHOOK, {
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

// ── Sheet init ────────────────────────────────────────────────────────────────

async function ensureSheet(sheets, spreadsheetId) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = meta.data.sheets.some(s => s.properties.title === SHEET);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: SHEET } } }],
      },
    });
    await batchAppendRows(sheets, SHEET, [[
      'Week Of',
      'MMM Followers', 'MMM Streams',
      'Solar Followers', 'Solar Streams',
      'Moonbyul Followers', 'Moonbyul Streams',
      'Wheein Followers', 'Wheein Streams',
      'Hwasa Followers', 'Hwasa Streams',
    ]]);
    console.log(`Created sheet: ${SHEET}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Starting Spotify weekly updater... (jitter: ${JITTER_MS}ms)`);
  await new Promise(r => setTimeout(r, JITTER_MS));

  const sheets        = await getSheetsClient();
  const spreadsheetId = process.env.SPREADSHEET_ID;

  await ensureSheet(sheets, spreadsheetId);

  const history = await getSheetData(sheets, SHEET);
  const lastRow = history.length > 1 ? history[history.length - 1] : null;

  const prev = lastRow ? {
    mmm:      { followers: +lastRow[1],  streams: +lastRow[2]  },
    solar:    { followers: +lastRow[3],  streams: +lastRow[4]  },
    moonbyul: { followers: +lastRow[5],  streams: +lastRow[6]  },
    wheein:   { followers: +lastRow[7],  streams: +lastRow[8]  },
    hwasa:    { followers: +lastRow[9],  streams: +lastRow[10] },
  } : null;

  // Spotify token
  const token = await getSpotifyToken();

  // Scrape all artists
  const current = {};
  for (const artist of ARTISTS) {
    console.log(`Fetching ${artist.label}...`);
    const followers = await getSpotifyFollowers(token, artist.id);
    const streams   = await scrapeTotalStreams(artist.kworb);
    current[artist.key] = { followers, streams };
    console.log(`  Followers: ${fmt(followers)} | Streams: ${fmt(streams)}`);
    await new Promise(r => setTimeout(r, 2000));
  }

  const mmm    = current.mmm;
  const pMmm   = prev?.mmm;

  // ── Post 1: Group ──
  const post1 = [
    `#MAMAMOO Spotify - Weekly Update`,
    ``,
    `Followers: ${fmt(mmm.followers)} (+${fmt(mmm.followers - (pMmm?.followers ?? mmm.followers))})`,
    ``,
    `Total Streams Across All Credits: ${fmt(mmm.streams)} (+${fmt(mmm.streams - (pMmm?.streams ?? mmm.streams))}) 🔼`,
    ``,
    `🔗${ARTISTS[0].url}`,
    ``,
    `#마마무 #ママム`,
    `@RBW_MAMAMOO`,
  ].join('\n');

  // ── Post 2: Member followers ──
  const memberFollowerLines = ARTISTS.slice(1).map(a => {
    const c = current[a.key];
    const p = prev?.[a.key];
    return `${a.handle}: ${fmt(c.followers)} ${delta(c.followers, p?.followers)}\n🔗${a.url}`;
  }).join('\n\n');
  const post2 = [
    `#MAMAMOO Members' Spotify Followers - Weekly Update`,
    ``,
    memberFollowerLines,
    ``,
    `#마마무 #ママム`,
    `@RBW_MAMAMOO`,
  ].join('\n');

  // ── Post 3: Member streams ──
  const memberStreamLines = ARTISTS.slice(1).map(a => {
    const c = current[a.key];
    const p = prev?.[a.key];
    return `${a.handle}: ${fmt(c.streams)}\n ${delta(c.streams, p?.streams)}`;
  }).join('\n\n');
  const post3 = [
    `#MAMAMOO Members' Total Spotify Streams (across all credits) - Weekly Update`,
    ``,
    memberStreamLines,
    ``,
    `#마마무 #ママム`,
    `@RBW_MAMAMOO`,
    `@THEL1VE_LABEL`,
  ].join('\n');

  await sendEmbed(post1, 'Spotify Weekly — Group');
  await new Promise(r => setTimeout(r, 2000));
  await sendEmbed(post2, 'Spotify Weekly — Member Followers');
  await new Promise(r => setTimeout(r, 2000));
  await sendEmbed(post3, 'Spotify Weekly — Member Streams');

  // ── Append to Sheet 15 ──
  const weekOf = getPHTTimestamp().split(' ')[0];
  await batchAppendRows(sheets, SHEET, [[
    weekOf,
    mmm.followers,              mmm.streams,
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
