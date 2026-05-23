'use strict';

const { getSheetsClient, getSheetData, getPHTTimestamp, appendSheetRow } = require('./helpers');
const fetch = require('node-fetch');

// ── Config ────────────────────────────────────────────────────────────────────

const ARTIST_TERMS = [
  'MAMAMOO', 'MAMAMOO+',
  'Solar',
  'Moon Byul', 'Moonbyul',
  'Whee In', 'Wheein',
  'Hwa Sa', 'Hwasa', 'HWASA',
];

const ONOFF_CHARTS = [
  { name: 'Digital Chart',       serviceGbn: 'ALL'   },
  { name: 'Streaming Chart',     serviceGbn: 'S1040' },
  { name: 'Download Chart',      serviceGbn: 'S1020' },
  { name: 'BGM Chart',           serviceGbn: 'S1060' },
  { name: 'V Coloring Chart',    serviceGbn: 'S4010' },
  { name: 'Singing Room Chart',  serviceGbn: 'S3010' },
  { name: 'Bell Chart',          serviceGbn: 'S2020' },
  { name: 'Ring Chart',          serviceGbn: 'S2040' },
];

const BASE_URL  = 'https://circlechart.kr';
const SHEET     = 'Korean Charts Tracker';

// ── Date helpers ──────────────────────────────────────────────────────────────

function getCurrentWeekParams() {
  // Circle Chart week = Sun–Sat KST. We derive hitYear + targetTime (week number).
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const year = now.getFullYear();

  // Week number: days since Jan 1, adjusted to Sun start
  const startOfYear = new Date(year, 0, 1);
  const dayOfYear   = Math.floor((now - startOfYear) / 86400000);
  const weekNum     = Math.ceil((dayOfYear + startOfYear.getDay() + 1) / 7);
  const targetTime  = String(weekNum).padStart(2, '0');

  return { hitYear: String(year), targetTime, yearTime: '3' };
}

// ── API callers ───────────────────────────────────────────────────────────────

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
  if (!res.ok) throw new Error(`onoff API error ${res.status} for ${serviceGbn}`);
  const data = await res.json();
  return data.List || [];
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
  if (!res.ok) throw new Error(`album API error ${res.status}`);
  const data = await res.json();
  return data.List || [];
}

// ── Filter ────────────────────────────────────────────────────────────────────

function isOurArtist(artistName) {
  if (!artistName) return false;
  const lower = artistName.toLowerCase();
  return ARTIST_TERMS.some(term => lower.includes(term.toLowerCase()));
}

// ── Discord ───────────────────────────────────────────────────────────────────

function rankStatusEmoji(status) {
  if (status === 'new')  return '🆕';
  if (status === 'up')   return '🔺';
  if (status === 'down') return '🔻';
  if (status === 'hot')  return '🔥';
  return '➖';
}

async function sendEmbed(embed) {
  const webhookUrl = process.env.DISCORD_MILESTONE_WEBHOOK;
  const res = await fetch(webhookUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ embeds: [embed] }),
  });
  if (res.status === 429) {
    const retry = (await res.json()).retry_after || 2;
    await new Promise(r => setTimeout(r, retry * 1000));
    await sendEmbed(embed);
  }
}

async function postChartEntry({ chartName, rank, rankStatus, rankChange, title, artist, album, score, weekLabel }) {
  const emoji  = rankStatusEmoji(rankStatus);
  const change = rankChange > 0 ? `(${rankChange})` : '';

  const description = [
    `**${rank}.** ${emoji} ${change}`,
    `🎵 **${title}**`,
    `🎤 ${artist}`,
    album ? `💿 ${album}` : null,
    score ? `📊 Score: ${Number(score).toLocaleString('en-US')}` : null,
    ``,
    `📅 ${weekLabel}`,
    `#MAMAMOO #마마무 @RBW_MAMAMOO`,
  ].filter(l => l !== null).join('\n');

  await sendEmbed({
    title: `[CIRCLE CHART] ${chartName}`,
    color: 3066993,
    description,
  });
}

// ── Dedup ─────────────────────────────────────────────────────────────────────

async function alreadyLogged(sheets, chartName, weekLabel, rank) {
  const rows = await getSheetData(sheets, SHEET);
  return rows.some(r => r[1] === chartName && r[2] === weekLabel && r[3] === String(rank));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Starting Circle Chart scraper...');

  const sheets = await getSheetsClient();
  const params = getCurrentWeekParams();
  const weekLabel = `${params.hitYear} Week ${params.targetTime}`;
  console.log(`Checking: ${weekLabel}`);

  const hits = [];

  // Onoff charts
  for (const chart of ONOFF_CHARTS) {
    console.log(`Fetching ${chart.name}...`);
    try {
      const list = await fetchOnoffChart(chart.serviceGbn, params);
      for (const row of list) {
        if (isOurArtist(row.ARTIST_NAME)) {
          hits.push({
            chartName:  chart.name,
            rank:       row.SERVICE_RANKING,
            rankStatus: row.RankStatus,
            rankChange: row.RankChange,
            title:      row.SONG_NAME,
            artist:     row.ARTIST_NAME,
            album:      row.ALBUM_NAME,
            score:      row.ROW_CNT,
            weekLabel,
          });
        }
      }
    } catch (e) {
      console.error(`Failed ${chart.name}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 1500));
  }

  // Album chart
  console.log('Fetching Album Chart...');
  try {
    const list = await fetchAlbumChart(params);
    for (const row of list) {
      if (isOurArtist(row.ARTIST_NAME)) {
        hits.push({
          chartName:  'Album Chart',
          rank:       row.SERVICE_RANKING,
          rankStatus: row.RankStatus,
          rankChange: row.RankChange,
          title:      row.ALBUM_NAME,
          artist:     row.ARTIST_NAME,
          album:      null,
          score:      row.Album_CNT,
          weekLabel,
        });
      }
    }
  } catch (e) {
    console.error(`Failed Album Chart: ${e.message}`);
  }

  console.log(`Found ${hits.length} hit(s).`);

  // Post + log new hits only
  for (const hit of hits) {
    const seen = await alreadyLogged(sheets, hit.chartName, hit.weekLabel, hit.rank);
    if (seen) {
      console.log(`Already logged: ${hit.chartName} #${hit.rank} — skipping`);
      continue;
    }

    await postChartEntry(hit);
    await appendSheetRow(sheets, SHEET, [
      getPHTTimestamp(),
      hit.chartName,
      hit.weekLabel,
      hit.rank,
      hit.title,
      hit.artist,
      hit.score || '',
    ]);
    console.log(`Posted: ${hit.chartName} #${hit.rank} — ${hit.title} (${hit.artist})`);
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log('Circle Chart scraper complete.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
