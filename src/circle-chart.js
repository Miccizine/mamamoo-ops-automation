'use strict';

const {
  getSheetsClient, getSheetData, getPHTTimestamp,
  appendSheetRow, updateSheetRow, getComebackMode
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

// Col indices (0-based for array, 1-based for Sheets row)
const COL = {
  TRACK_NAME:    0,  // A
  PLATFORM:      1,  // B
  CHART_TYPE:    2,  // C
  CURRENT_POS:   3,  // D
  MOVEMENT:      4,  // E
  PEAK_POS:      5,  // F
  PEAK_DATE:     6,  // G
  ENTRY_DATE:    7,  // H
  LAST_SEEN:     8,  // I
  WEEK:          9,  // J
  REENTRY_DATE: 10,  // K
};

// ── Date helpers ──────────────────────────────────────────────────────────────

function getKSTDate() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
}

function getCurrentWeekParams() {
  const now         = getKSTDate();
  const year        = now.getFullYear();
  const startOfYear = new Date(year, 0, 1);
  const dayOfYear   = Math.floor((now - startOfYear) / 86400000);
  const weekNum     = Math.ceil((dayOfYear + startOfYear.getDay() + 1) / 7);
  const targetTime  = String(weekNum).padStart(2, '0');
  return { hitYear: String(year), targetTime, yearTime: '3' };
}

function weekLabel(params) {
  return `${params.hitYear}${params.targetTime}`;
}

function todayPHT() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' }).replace(/-/g, '');
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function isOurArtist(artistName) {
  if (!artistName) return false;
  const lower = artistName.toLowerCase();
  return ARTIST_TERMS.some(t => lower.includes(t.toLowerCase()));
}

function formatMovement(rankChange, rankStatus) {
  if (rankStatus === 'new') return 'new';
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
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = meta.data.sheets.some(s => s.properties.title === SHEET);
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
  }
}

async function postChartEntry(hit, isReentry) {
  const emoji    = rankStatusEmoji(hit.rankStatus);
  const peakLine = hit.peakPos ? `🏆 Peak: #${hit.peakPos}` : '';
  const reentry  = isReentry ? '\n🔄 **Re-entry**' : '';

  const description = [
    `**#${hit.rank}** ${emoji} ${hit.movement}${reentry}`,
    ``,
    `🎵 **${hit.title}**`,
    `🎤 ${hit.artist}`,
    peakLine,
    ``,
    `📅 Week ${hit.week}`,
    `#MAMAMOO #마마무 @RBW_MAMAMOO`,
  ].filter(Boolean).join('\n');

  await sendEmbed({
    title: `[CIRCLE CHART] ${hit.chartName}`,
    color: 3066993,
    description,
  });
}

// ── State management ──────────────────────────────────────────────────────────

function findExistingRow(rows, trackName, chartType) {
  // rows[0] = headers, rows[1..] = data; returns { rowIndex (1-based sheet row), data }
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    if (
      (r[COL.TRACK_NAME] || '').toLowerCase() === trackName.toLowerCase() &&
      (r[COL.CHART_TYPE] || '').toLowerCase() === chartType.toLowerCase()
    ) {
      return { sheetRowIndex: i + 1, data: r }; // +1 because sheet rows are 1-based
    }
  }
  return null;
}

function isReentry(lastSeen) {
  if (!lastSeen) return false;
  // lastSeen stored as YYYYMMDD
  const last = new Date(
    lastSeen.slice(0, 4) + '-' + lastSeen.slice(4, 6) + '-' + lastSeen.slice(6, 8)
  );
  const now  = getKSTDate();
  const diffDays = Math.floor((now - last) / 86400000);
  return diffDays > 9; // more than 1 full chart week gap
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Starting Circle Chart scraper...');

  const sheets      = await getSheetsClient();
  const isComeback  = await getComebackMode(sheets);
  console.log(`Mode: ${isComeback ? 'COMEBACK' : 'NORMAL'}`);

  await ensureSheet(sheets);

  const params = getCurrentWeekParams();
  const week   = weekLabel(params);
  const today  = todayPHT();
  console.log(`Week: ${week}`);

  const hits = [];

  // Fetch onoff charts
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
          week,
          peakPos:    null, // resolved below
        });
      }
    } catch (e) {
      console.error(`Failed ${chart.name}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 1500));
  }

  // Fetch album chart
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
    const reentry  = existing ? isReentry(existing.data[COL.LAST_SEEN]) : false;

    if (existing) {
      const prevPos  = parseInt(existing.data[COL.CURRENT_POS], 10) || hit.rank;
      const prevPeak = parseInt(existing.data[COL.PEAK_POS], 10)    || hit.rank;
      const newPeak  = Math.min(hit.rank, prevPeak);
      const peakDate = newPeak < prevPeak ? today : (existing.data[COL.PEAK_DATE] || today);

      hit.peakPos = newPeak;

      // Only post if this week hasn't been logged yet
      const alreadyThisWeek = existing.data[COL.WEEK] === week;

      const updatedRow = [...existing.data];
      updatedRow[COL.CURRENT_POS]  = hit.rank;
      updatedRow[COL.MOVEMENT]     = hit.movement;
      updatedRow[COL.PEAK_POS]     = newPeak;
      updatedRow[COL.PEAK_DATE]    = peakDate;
      updatedRow[COL.LAST_SEEN]    = today;
      updatedRow[COL.WEEK]         = week;
      if (reentry) updatedRow[COL.REENTRY_DATE] = today;

      await updateSheetRow(sheets, SHEET, existing.sheetRowIndex, updatedRow);

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
      newRow[COL.TRACK_NAME]  = hit.title;
      newRow[COL.PLATFORM]    = 'circlechart';
      newRow[COL.CHART_TYPE]  = hit.chartName;
      newRow[COL.CURRENT_POS] = hit.rank;
      newRow[COL.MOVEMENT]    = hit.movement;
      newRow[COL.PEAK_POS]    = hit.rank;
      newRow[COL.PEAK_DATE]   = today;
      newRow[COL.ENTRY_DATE]  = today;
      newRow[COL.LAST_SEEN]   = today;
      newRow[COL.WEEK]        = week;
      newRow[COL.REENTRY_DATE] = '';

      await appendSheetRow(sheets, SHEET, newRow);
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
