const {
  getSheetsClient,
  getSheetData,
  appendSheetRow,
  batchAppendRows,
  getMemberConfig,
  findMatchInRegistry,
  getComebackMode,
  getPHTTimestamp,
  normalizeTitle,
  flagNewRelease
} = require('./helpers');

const fetch = require('node-fetch');

const ARTIST_PAGES = [
  { url: 'https://kworb.net/itunes/artist/mamamoo.html',  label: 'MAMAMOO' },
  { url: 'https://kworb.net/itunes/artist/solar.html',    label: 'Solar' },
  { url: 'https://kworb.net/itunes/artist/moonbyul.html', label: 'Moonbyul' },
  { url: 'https://kworb.net/itunes/artist/wheein.html',   label: 'Wheein' },
  { url: 'https://kworb.net/itunes/artist/hwasa.html',    label: 'Hwasa' }
];

const WORLDWIDE_URLS = [
  'https://kworb.net/ww/index.html',
  'https://kworb.net/ww/index_full.html'
];

const MAMAMOO_KEYWORDS = [
  'mamamoo', 'solar', 'moonbyul', 'wheein', 'hwasa',
  '마마무', '솔라', '문별', '휘인', '화사'
];

// ── HTML Parsing ──────────────────────────────────────────────────────────────

function parseTableRows(html) {
  const results = [];
  const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];

  for (const row of rows) {
    const cells = [];
    const cellPattern = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch;
    while ((cellMatch = cellPattern.exec(row)) !== null) {
      cells.push(cellMatch[1].replace(/<[^>]+>/g, '').trim());
    }
    if (cells.length >= 3) results.push(cells);
  }
  return results;
}

// ── Peak Tracker Helpers ──────────────────────────────────────────────────────

function buildPeakMap(peakData) {
  const map = {};
  for (let i = 1; i < peakData.length; i++) {
    const row = peakData[i];
    if (!row[0] || !row[1]) continue;
    const key = `${row[0]}|${row[1]}`;
    map[key] = {
      rowIndex:     i + 1,
      peakPosition: parseInt(row[2]) || 999,
      dateAchieved: row[3] || '',
      lastSeen:     row[4] || '',
      entryDate:    row[5] || '',
      reentryDate:  row[6] || ''
    };
  }
  return map;
}

function getDayCount(entryDate, reentryDate) {
  const baseDate = reentryDate || entryDate;
  if (!baseDate) return 1;
  const start = new Date(baseDate);
  const now   = new Date();
  const diff  = Math.floor((now - start) / (1000 * 60 * 60 * 24));
  return Math.max(1, diff + 1);
}

function isReentry(lastSeen) {
  if (!lastSeen) return false;
  const last      = new Date(lastSeen);
  const now       = new Date();
  const hoursDiff = (now - last) / (1000 * 60 * 60);
  return hoursDiff > 12;
}

function isRecentRelease(releaseDate) {
  if (!releaseDate) return false;
  const release  = new Date(releaseDate);
  const now      = new Date();
  const daysDiff = (now - release) / (1000 * 60 * 60 * 24);
  return daysDiff <= 30;
}

// ── Discord Notification Builder ──────────────────────────────────────────────

function buildItunesNotification(type, data) {
  const {
    trackName, position, country, prevPosition,
    dayCount, peakPosition, memberConfig,
    appleUrl, songHashtags, isNew, isReentryFlag
  } = data;

  const config      = memberConfig;
  const closingLine = config.handle === '#MAMAMOO'
    ? '#마마무 #ママム #妈妈木\n@RBW_MAMAMOO'
    : `#마마무 #ママム #妈妈木\n#mamamoo ${config.label}`;

  const movement = prevPosition
    ? position < prevPosition
      ? `(+${prevPosition - position})`
      : position > prevPosition
      ? `(-${position - prevPosition})`
      : '(=)'
    : '(NEW)';

  const entryLabel = isReentryFlag ? '(Re-entry)' : isNew ? '(NEW)' : movement;
  const isPeak     = position <= peakPosition;
  const peakFlag   = isPeak && !isNew ? ' 🔥NEW PEAK' : '';

  let header, body, footer;

  if (country === 'Worldwide') {
    header = `Worldwide iTunes Song Chart 🌏`;
    body   = `#${position} ${config.handle} - ${trackName} ${entryLabel}${peakFlag}`;
    footer = dayCount > 1
      ? `[DAY ${dayCount}${isReentryFlag ? ' since re-entry' : ''} | PEAK #${Math.min(position, peakPosition)}]`
      : '';
  } else {
    header = `iTunes Song Chart 🎵`;
    body   = `#${position} ${country}`;
    footer = dayCount > 1
      ? `[DAY ${dayCount}${isReentryFlag ? ' since re-entry' : ''} | PEAK #${Math.min(position, peakPosition)}]`
      : '';
  }

  const lines = [header, '', body];
  if (footer) lines.push('', footer);
  if (appleUrl) lines.push('', `🔗 ${appleUrl}`);
  if (songHashtags) lines.push('', songHashtags);
  lines.push(closingLine);

  return lines.join('\n').trim();
}

async function sendItunesDiscord(notifications) {
  if (notifications.length === 0) return;
  const webhookUrl = process.env.DISCORD_MILESTONE_WEBHOOK;

  for (const n of notifications) {
    const message = {
      embeds: [{
        title:       '📊 CHART UPDATE — Pending Approval',
        color:       16744272,
        description: n.draft,
        footer:      { text: '✅ Approve and post manually to X | ❌ Discard' }
      }]
    };

    const response = await fetch(webhookUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(message)
    });

    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after') || 5;
      console.log(`Rate limited. Waiting ${retryAfter}s...`);
      await new Promise(r => setTimeout(r, retryAfter * 1000));
      await fetch(webhookUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(message)
      });
    } else if (!response.ok) {
      console.error(`Discord error ${response.status}`);
    } else {
      console.log(`Sent: ${n.trackName} — ${n.country} #${n.position}`);
    }

    await new Promise(r => setTimeout(r, 2000));
  }
}

// ── Peak Tracker Writer ───────────────────────────────────────────────────────

async function updatePeakTracker(sheets, peakMap, updates) {
  if (updates.length === 0) return;
  const sheetId = process.env.GOOGLE_SHEETS_ID;

  for (const u of updates) {
    const key      = `${u.trackName}|${u.country}`;
    const existing = peakMap[key];
    const now      = getPHTTimestamp();

    if (!existing) {
      await appendSheetRow(sheets, 'iTunes Peak Tracker', [
        u.trackName,
        u.country,
        u.position,
        now,
        now,
        now,
        ''
      ]);
      peakMap[key] = {
        peakPosition: u.position,
        lastSeen:     now,
        entryDate:    now,
        reentryDate:  ''
      };
    } else {
      const newPeak     = u.position < existing.peakPosition ? u.position : existing.peakPosition;
      const newPeakDate = u.position < existing.peakPosition ? now : existing.dateAchieved;
      const newReentry  = u.isReentry ? now : existing.reentryDate;

      await sheets.spreadsheets.values.update({
        spreadsheetId:    sheetId,
        range:            `iTunes Peak Tracker!C${existing.rowIndex}:G${existing.rowIndex}`,
        valueInputOption: 'USER_ENTERED',
        resource: {
          values: [[newPeak, newPeakDate, now, existing.entryDate, newReentry]]
        }
      });

      peakMap[key].peakPosition = newPeak;
      peakMap[key].lastSeen     = now;
      peakMap[key].reentryDate  = newReentry;
    }
  }
}

// ── Country Chart Scraper ─────────────────────────────────────────────────────

async function scrapeCountryCharts(sheets, registryData, peakData) {
  const peakMap       = buildPeakMap(peakData);
  const notifications = [];
  const peakUpdates   = [];
  const rawLogBuffer  = [];
  const processedKeys = new Set();

  for (const artist of ARTIST_PAGES) {
    let html;
    try {
      const res = await fetch(artist.url, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      html = await res.text();
    } catch(e) {
      console.error(`Fetch error for ${artist.label}: ${e.message}`);
      continue;
    }

    if (html.includes('not charting anywhere at the moment')) {
      console.log(`${artist.label} not charting on iTunes`);
      continue;
    }

    const rows = parseTableRows(html);

    for (const cells of rows) {
      if (cells.length < 3) continue;

      const kworbTitle = cells[0].trim();
      const country    = cells[1].trim();
      const position   = parseInt(cells[2].replace(/,/g, '')) || 0;

      if (!kworbTitle || !country || position === 0) continue;

      const entryKey = `${kworbTitle}|${country}`;
      if (processedKeys.has(entryKey)) continue;
      processedKeys.add(entryKey);

      const match = findMatchInRegistry(kworbTitle, registryData);

      if (!match) {
        await flagNewRelease(
          sheets,
          kworbTitle,
          artist.label,
          'iTunes/kworb',
          artist.url
        );
        continue;
      }

      const matchedRow     = match.row;
      const trackName      = matchedRow[0];
      const album          = matchedRow[2];
      const releaseDate    = matchedRow[3];
      const activeTracking = matchedRow[11];
      const appleUrl       = matchedRow[16] || '';
      const songHashtags   = matchedRow[17] || '';

      if (activeTracking.toString().trim().toLowerCase() !== 'yes') continue;

      const memberConfig  = getMemberConfig(matchedRow);
      const peakKey       = `${trackName}|${country}`;
      const existing      = peakMap[peakKey];
      const reentryFlag   = existing ? isReentry(existing.lastSeen) : false;
      const recentRelease = isRecentRelease(releaseDate);
      const isNew         = !existing;
      const isNewPeak     = existing && position < existing.peakPosition;
      const dayCount      = existing
        ? getDayCount(existing.entryDate, existing.reentryDate || '')
        : 1;
      const prevPosition  = existing ? existing.peakPosition : null;

      rawLogBuffer.push([
        getPHTTimestamp(),
        trackName,
        album,
        'iTunes',
        'Chart Position',
        position,
        '',
        artist.url
      ]);

      peakUpdates.push({
        trackName,
        country,
        position,
        isReentry: reentryFlag
      });

      const shouldNotify = recentRelease || reentryFlag || isNewPeak || isNew;

      if (shouldNotify) {
        const draft = buildItunesNotification('country', {
          trackName,
          position,
          country,
          prevPosition,
          dayCount,
          peakPosition:  existing ? existing.peakPosition : position,
          memberConfig,
          appleUrl,
          songHashtags,
          isNew,
          isReentryFlag: reentryFlag
        });

        notifications.push({
          draft,
          trackName,
          country,
          position,
          needsValidation: isNew && !recentRelease
        });
      }
    }

    await new Promise(r => setTimeout(r, 2000));
  }

  await batchAppendRows(sheets, 'Raw Scrape Log', rawLogBuffer);
  await updatePeakTracker(sheets, peakMap, peakUpdates);

  return notifications;
}

// ── Worldwide Chart Scraper ───────────────────────────────────────────────────

async function scrapeWorldwideChart(sheets, registryData, peakData) {
  const peakMap       = buildPeakMap(peakData);
  const notifications = [];
  const peakUpdates   = [];
  const rawLogBuffer  = [];

  for (const url of WORLDWIDE_URLS) {
    let html;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      html = await res.text();
    } catch(e) {
      console.error(`Worldwide fetch error: ${e.message}`);
      continue;
    }

    const rows = parseTableRows(html);

    for (const cells of rows) {
      const rowText    = cells.join(' ').toLowerCase();
      const isMamamoo  = MAMAMOO_KEYWORDS.some(kw => rowText.includes(kw));
      if (!isMamamoo) continue;

      const position    = parseInt(cells[0].replace(/,/g, '')) || 0;
      const artistTitle = cells[2] || cells[1] || '';
      if (position === 0 || !artistTitle) continue;

      const parts     = artistTitle.split(' - ');
      const trackName = parts.length > 1
        ? parts.slice(1).join(' - ').trim()
        : artistTitle.trim();

      const match        = findMatchInRegistry(trackName, registryData);

      if (!match) {
        await flagNewRelease(
          sheets,
          trackName,
          '',
          'iTunes Worldwide/kworb',
          url
        );
        continue;
      }

      const appleUrl     = match.row[16] || '';
      const songHashtags = match.row[17] || '';
      const releaseDate  = match.row[3];
      const memberConfig = getMemberConfig(match.row);

      const peakKey      = `${trackName}|Worldwide`;
      const existing     = peakMap[peakKey];
      const reentryFlag  = existing ? isReentry(existing.lastSeen) : false;
      const recentRelease = isRecentRelease(releaseDate);
      const isNew        = !existing;
      const isNewPeak    = existing && position < existing.peakPosition;
      const dayCount     = existing
        ? getDayCount(existing.entryDate, existing.reentryDate || '')
        : 1;
      const prevPosition = existing ? existing.peakPosition : null;

      rawLogBuffer.push([
        getPHTTimestamp(),
        trackName,
        '',
        'iTunes',
        'Worldwide Position',
        position,
        '',
        url
      ]);

      peakUpdates.push({
        trackName,
        country:   'Worldwide',
        position,
        isReentry: reentryFlag
      });

      const shouldNotify = recentRelease || reentryFlag || isNewPeak || isNew;

      if (shouldNotify) {
        const draft = buildItunesNotification('worldwide', {
          trackName,
          position,
          country:       'Worldwide',
          prevPosition,
          dayCount,
          peakPosition:  existing ? existing.peakPosition : position,
          memberConfig,
          appleUrl,
          songHashtags,
          isNew,
          isReentryFlag: reentryFlag
        });

        notifications.push({
          draft,
          trackName,
          country:         'Worldwide',
          position,
          needsValidation: isNew && !recentRelease
        });
      }
    }

    await new Promise(r => setTimeout(r, 2000));
  }

  await batchAppendRows(sheets, 'Raw Scrape Log', rawLogBuffer);
  await updatePeakTracker(sheets, peakMap, peakUpdates);

  return notifications;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Starting iTunes scraper...');

  const sheets      = await getSheetsClient();
  const isComeback  = await getComebackMode(sheets);
  console.log(`Mode: ${isComeback ? 'COMEBACK' : 'NORMAL'}`);

  const registryData = await getSheetData(sheets, 'Master Registry');
  const peakData     = await getSheetData(sheets, 'iTunes Peak Tracker');

  const countryNotifs   = await scrapeCountryCharts(sheets, registryData, peakData);
  const worldwideNotifs = await scrapeWorldwideChart(sheets, registryData, peakData);

  const allNotifications = [...worldwideNotifs, ...countryNotifs];

  const validationNeeded = allNotifications.filter(n => n.needsValidation);
  if (validationNeeded.length > 0) {
    console.log(`${validationNeeded.length} entries need team validation`);
  }

  console.log(`Sending ${allNotifications.length} notifications...`);
  await sendItunesDiscord(allNotifications);

  console.log('iTunes scraper complete.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
