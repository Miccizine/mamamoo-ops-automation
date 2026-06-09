'use strict';

const {
  getSheetsClient, getSheetData, getPHTTimestamp,
  appendSheetRow, updateSheetRow, getComebackMode,
  getMemberConfig, buildClosingTags
} = require('./helpers');
const fetch = require('node-fetch');

// ── Config ────────────────────────────────────────────────────────────────────

const ARTIST_TERMS = [
  'MAMAMOO', 'MAMAMOO+',
  'Solar',
  'Moon Byul', 'Moonbyul',
  'Whee In', 'Wheein',
  'Hwa Sa', 'Hwasa', 'HWASA',
];

// Artist name → Discord tags (for posts not needing registry lookup)
const ARTIST_TAG_MAP = {
  'mamamoo+':  { handle: '#MAMAMOOplus', tags: '#MAMAMOOplus #마마무플러스\n#SOLAR #솔라 #ソラ #金容仙\n#MOONBYUL #문별 #ムンビョル #文星伊', closing: '#마마무 @RBW_MAMAMOO' },
  'solar':     { handle: '#SOLAR',       tags: '#SOLAR #솔라 #ソラ #金容仙',                                                                   closing: '#마마무 @RBW_MAMAMOO' },
  'moon byul': { handle: '#MOONBYUL',    tags: '#MOONBYUL #문별 #ムンビョル #文星伊',                                                           closing: '#마마무 @RBW_MAMAMOO' },
  'moonbyul':  { handle: '#MOONBYUL',    tags: '#MOONBYUL #문별 #ムンビョル #文星伊',                                                           closing: '#마마무 @RBW_MAMAMOO' },
  'whee in':   { handle: '#WHEEIN',      tags: '#WHEEIN #휘인 #フィイン #丁輝人',                                                               closing: '#마마무 @WheeIn_0fficial' },
  'wheein':    { handle: '#WHEEIN',      tags: '#WHEEIN #휘인 #フィイン #丁輝人',                                                               closing: '#마마무 @WheeIn_0fficial' },
  'hwa sa':    { handle: '#HWASA',       tags: '#HWASA #화사 #ファサ #華莎',                                                                    closing: '#마마무 @OfficialPnation' },
  'hwasa':     { handle: '#HWASA',       tags: '#HWASA #화사 #ファサ #華莎',                                                                    closing: '#마마무 @OfficialPnation' },
};
const GROUP_TAGS = { handle: '#MAMAMOO', tags: '#MAMAMOO #마마무', closing: '#마마무 #ママム #妈妈木\n@RBW_MAMAMOO' };

const ONOFF_CHARTS = [
  { name: 'Digital Chart',      serviceGbn: 'ALL'   },
  { name: 'Streaming Chart',    serviceGbn: 'S1040' },
  { name: 'Download Chart',     serviceGbn: 'S1020' },
  { name: 'BGM Chart',          serviceGbn: 'S1060' },
  { name: 'V Coloring Chart',   serviceGbn: 'S4010' },
  { name: 'Singing Room Chart', serviceGbn: 'S3010' },
  { name: 'Bell Chart',         serviceGbn: 'S2020' },
  { name: 'Ring Chart',         serviceGbn: 'S2040' },
];

const BASE_URL = 'https://circlechart.kr';
const SHEET    = 'Circle Chart Tracker';

const COL = {
  TRACK_NAME:   0,
  PLATFORM:     1,
  CHART_TYPE:   2,
  CURRENT_POS:  3,
  MOVEMENT:     4,
  PEAK_POS:     5,
  PEAK_DATE:    6,
  ENTRY_DATE:   7,
  LAST_SEEN:    8,
  WEEK:         9,
  REENTRY_DATE: 10,
};

// ── Date helpers ──────────────────────────────────────────────────────────────

function getKSTDate() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
}

function getCurrentWeekParams() {
  const now  = getKSTDate();
  const year = now.getFullYear();

  // Circle Chart uses yearTime=1; week number = floor((dayOfYear - 1) / 7) + 1
  const startOfYear = new Date(year, 0, 1);
  const dayOfYear   = Math.floor((now - startOfYear) / 86400000);
  const weekNum     = Math.floor(dayOfYear / 7) + 1;

  return {
    hitYear:    String(year),
    targetTime: String(weekNum).padStart(2, '0'),
    yearTime:   '1',
  };
}

function weekLabel(params) {
  return `${params.hitYear}${params.targetTime}`;
}

function todayPHT() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' }).replace(/-/g, '');
}

function kstTimestamp() {
  return new Date().toLocaleString('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).replace(',', '');
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
  if (!res.ok) throw new Error(`onoff API ${res.status} for ${serviceGbn}`);
  const json = await res.json();
  // List is an object with numeric string keys, not an array
  return Object.values(json.List || {});
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
  const json = await res.json();
  return Object.values(json.List || {});
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isOurArtist(artistName) {
  if (!artistName) return false;
  const lower = artistName.toLowerCase();
  return ARTIST_TERMS.some(t => lower.includes(t.toLowerCase()));
}

function resolveArtistTags(artistName) {
  if (!artistName) return GROUP_TAGS;
  const lower = artistName.toLowerCase();
  for (const [key, val] of Object.entries(ARTIST_TAG_MAP)) {
    if (lower.includes(key)) return val;
  }
  return GROUP_TAGS;
}

function formatMovement(rankChange, rankStatus) {
  if (rankStatus === 'new')  return '(NEW)';
  if (rankStatus === 'same') return '(=)';
  const n = parseInt(rankChange, 10);
  if (isNaN(n) || n === 0) return '(=)';
  return n > 0 ? `(+${n})` : `(${n})`;
}

function rankStatusEmoji(status) {
  if (status === 'new')  return '🆕';
  if (status === 'up')   return '🔺';
  if (status === 'down') return '🔻';
  if (status === 'hot')  return '🔥';
  return '➖';
}

// ── Sheet init ────────────────────────────────────────────────────────────────

async function ensureSheet(sheets) {
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
  const meta          = await sheets.spreadsheets.get({ spreadsheetId });
  const exists        = meta.data.sheets.some(s => s.properties.title === SHEET);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: SHEET } } }] },
    });
    await appendSheetRow(sheets, SHEET, [
      'Track Name', 'Platform', 'Chart Type', 'Current Position',
      'Movement', 'Peak Position', 'Peak Date', 'Entry Date',
      'Last Seen', 'Week', 'Re-entry Date',
    ]);
    console.log(`Created sheet: ${SHEET}`);
  }
}

// ── Discord ───────────────────────────────────────────────────────────────────

async function sendEmbed(embed) {
  const res = await fetch(process.env.DISCORD_MILESTONE_WEBHOOK, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ embeds: [embed] }),
  });
  if (res.status === 429) {
    const retry = (await res.json()).retry_after || 2;
    await new Promise(r => setTimeout(r, retry * 1000));
    await sendEmbed(embed);
  } else if (!res.ok) {
    console.error(`Discord webhook error: ${res.status}`);
  }
}

async function postChartEntry(hit, isReentry) {
  const emoji    = rankStatusEmoji(hit.rankStatus);
  const peakLine = hit.peakPos ? `🏆 Peak: #${hit.peakPos}` : '';
  const reentryLine = isReentry ? '\n🔄 Re-entry' : '';
  const tags     = resolveArtistTags(hit.artist);

  const description = [
    `**#${hit.rank}** ${emoji} ${hit.movement}${reentryLine}`,
    '',
    `🎵 **${hit.title}**`,
    `🎤 ${hit.artist}`,
    peakLine,
    '',
    `📅 Week ${hit.week}`,
    '',
    tags.tags,
    tags.closing,
  ].filter(Boolean).join('\n');

  await sendEmbed({
    title: `[CIRCLE CHART] ${hit.chartName}`,
    color: 3066993,
    description,
    footer: { text: '✅ Approve and post manually to X | ❌ Discard' },
  });
}

// ── State management ──────────────────────────────────────────────────────────

function findExistingRow(rows, trackName, chartType) {
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    if (
      (r[COL.TRACK_NAME] || '').toLowerCase() === trackName.toLowerCase() &&
      (r[COL.CHART_TYPE] || '').toLowerCase() === chartType.toLowerCase()
    ) {
      return { sheetRowIndex: i + 1, data: r };
    }
  }
  return null;
}

function checkReentry(lastSeen) {
  if (!lastSeen) return false;
  const last    = new Date(`${lastSeen.slice(0, 4)}-${lastSeen.slice(4, 6)}-${lastSeen.slice(6, 8)}`);
  const now     = getKSTDate();
  const diffDays = Math.floor((now - last) / 86400000);
  return diffDays > 9;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Starting Circle Chart scraper...');

  const sheets     = await getSheetsClient();
  const isComeback = await getComebackMode(sheets);
  console.log(`Mode: ${isComeback ? 'COMEBACK' : 'NORMAL'}`);

  await ensureSheet(sheets);

  const params = getCurrentWeekParams();
  const week   = weekLabel(params);
  const today  = todayPHT();
  console.log(`Week params: ${JSON.stringify(params)}`);

  const hits = [];

  // ── Fetch onoff charts ────────────────────────────────────────────────────
  for (const chart of ONOFF_CHARTS) {
    console.log(`Fetching ${chart.name}...`);
    try {
      const list = await fetchOnoffChart(chart.serviceGbn, params);
      for (const row of list) {
        if (!isOurArtist(row.ARTIST_NAME)) continue;
        hits.push({
          chartName:  chart.name,
          rank:       parseInt(row.SERVICE_RANKING, 10),
          rankStatus: row.RankStatus,
          rankChange: row.RankChange,
          movement:   formatMovement(row.RankChange, row.RankStatus),
          title:      row.SONG_NAME,
          artist:     row.ARTIST_NAME,
          score:      row.ROW_CNT || '',   // digital stream count
          week,
          peakPos:    null,
        });
      }
    } catch (e) {
      console.error(`Failed ${chart.name}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 1500));
  }

  // ── Fetch album chart ─────────────────────────────────────────────────────
  console.log('Fetching Album Chart...');
  try {
    const list = await fetchAlbumChart(params);
    for (const row of list) {
      if (!isOurArtist(row.ARTIST_NAME)) continue;
      hits.push({
        chartName:  'Album Chart',
        rank:       parseInt(row.SERVICE_RANKING, 10),
        rankStatus: row.RankStatus,
        rankChange: row.RankChange,
        movement:   formatMovement(row.RankChange, row.RankStatus),
        title:      row.ALBUM_NAME,
        artist:     row.ARTIST_NAME,
        score:      row.Album_CNT || '',   // physical album sales
        week,
        peakPos:    null,
      });
    }
  } catch (e) {
    console.error(`Failed Album Chart: ${e.message}`);
  }

  console.log(`Found ${hits.length} hit(s).`);
  if (hits.length === 0) {
    console.log('No entries found. Exiting.');
    return;
  }

  // Load current sheet state once
  let sheetRows = await getSheetData(sheets, SHEET);

  for (const hit of hits) {
    const existing = findExistingRow(sheetRows, hit.title, hit.chartName);
    const reentry  = existing ? checkReentry(existing.data[COL.LAST_SEEN]) : false;

    if (existing) {
      const prevPeak = parseInt(existing.data[COL.PEAK_POS], 10) || hit.rank;
      const newPeak  = Math.min(hit.rank, prevPeak);
      const peakDate = newPeak < prevPeak ? today : (existing.data[COL.PEAK_DATE] || today);
      const alreadyThisWeek = existing.data[COL.WEEK] === week;

      hit.peakPos = newPeak;

      const nothingChanged =
        alreadyThisWeek &&
        !reentry &&
        parseInt(existing.data[COL.CURRENT_POS], 10) === hit.rank &&
        prevPeak === newPeak;

      if (nothingChanged) {
        console.log(`No change: ${hit.chartName} — ${hit.title}`);
        continue;
      }

      const updatedRow = [...existing.data];
      updatedRow[COL.CURRENT_POS] = hit.rank;
      updatedRow[COL.MOVEMENT]    = hit.movement;
      updatedRow[COL.PEAK_POS]    = newPeak;
      updatedRow[COL.PEAK_DATE]   = peakDate;
      updatedRow[COL.LAST_SEEN]   = today;
      updatedRow[COL.WEEK]        = week;
      if (reentry) updatedRow[COL.REENTRY_DATE] = today;

      await updateSheetRow(sheets, SHEET, existing.sheetRowIndex, updatedRow);

      // Log album chart updates to Physical Sales Log
      if (hit.chartName === 'Album Chart') {
        await appendSheetRow(sheets, 'Physical Sales Log', [
          kstTimestamp(), hit.title, 'Circle Chart', hit.score, '',
        ]);
      }

      if (!alreadyThisWeek || reentry) {
        await postChartEntry(hit, reentry);
        await new Promise(r => setTimeout(r, 2000));
      } else {
        console.log(`Already posted this week: ${hit.chartName} — ${hit.title}`);
      }

    } else {
      // New entry
      hit.peakPos = hit.rank;
      const newRow = new Array(11).fill('');
      newRow[COL.TRACK_NAME]   = hit.title;
      newRow[COL.PLATFORM]     = 'circlechart';
      newRow[COL.CHART_TYPE]   = hit.chartName;
      newRow[COL.CURRENT_POS]  = hit.rank;
      newRow[COL.MOVEMENT]     = hit.movement;
      newRow[COL.PEAK_POS]     = hit.rank;
      newRow[COL.PEAK_DATE]    = today;
      newRow[COL.ENTRY_DATE]   = today;
      newRow[COL.LAST_SEEN]    = today;
      newRow[COL.WEEK]         = week;
      newRow[COL.REENTRY_DATE] = '';

      await appendSheetRow(sheets, SHEET, newRow);

      if (hit.chartName === 'Album Chart') {
        await appendSheetRow(sheets, 'Physical Sales Log', [
          kstTimestamp(), hit.title, 'Circle Chart', hit.score, '',
        ]);
      }

      await postChartEntry(hit, false);
      await new Promise(r => setTimeout(r, 2000));

      // Refresh sheet rows after append so subsequent lookups are accurate
      sheetRows = await getSheetData(sheets, SHEET);
    }

    console.log(`Processed: ${hit.chartName} #${hit.rank} — ${hit.title}`);
  }

  console.log('Circle Chart scraper complete.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
