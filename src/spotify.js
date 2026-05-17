'use strict';

const {
  getSheetsClient,
  getSheetData,
  batchAppendRows,
  appendSheetRow,
  getMemberConfig,
  buildClosingTags,
  sendDiscordDraft,
  getComebackMode,
  getPHTTimestamp,
  formatMilestoneNumber,
  normalizeTitle,
  findMatchInRegistry,
  flagNewRelease
} = require('./helpers');

const fetch = require('node-fetch');

// ── Startup jitter ────────────────────────────────────────────────────────────
const JITTER_MS = Math.floor(Math.random() * 20000);

const ARTIST_PAGES = [
  { url: 'https://kworb.net/spotify/artist/0XATRDCYuuGhk0oE7C0o5G_songs.html', label: 'MAMAMOO' },
  { url: 'https://kworb.net/spotify/artist/5cYcI546S8Lf97m4mNdYLD_songs.html', label: 'Solar' },
  { url: 'https://kworb.net/spotify/artist/1eTft3tXynrKdo6XD7QHLL.html',        label: 'Moonbyul' },
  { url: 'https://kworb.net/spotify/artist/0BqRGrwqndrtNkojXiqIzL_songs.html', label: 'Wheein' },
  { url: 'https://kworb.net/spotify/artist/7bmYpVgQub656uNTu6qGNQ_songs.html', label: 'Hwasa' }
];

// ── Scrape helpers ────────────────────────────────────────────────────────────

function parseKworbTable(html) {
  const tracks = [];
  const rows   = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];

  for (const row of rows) {
    const cells        = [];
    const cellPattern  = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch;
    while ((cellMatch = cellPattern.exec(row)) !== null) {
      cells.push(cellMatch[1].replace(/<[^>]+>/g, '').trim());
    }
    if (cells.length < 3) continue;

    let title, streams, daily;
    if (cells.length >= 4) {
      title   = cells[1].trim();
      streams = parseInt(cells[2].replace(/,/g, ''), 10) || 0;
      daily   = parseInt(cells[3].replace(/,/g, ''), 10) || 0;
    } else {
      title   = cells[0].trim();
      streams = parseInt(cells[1].replace(/,/g, ''), 10) || 0;
      daily   = parseInt(cells[2].replace(/,/g, ''), 10) || 0;
    }

    if (!title) continue;
    tracks.push({ title, streams, daily });
  }

  return tracks;
}

async function scrapePage(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.text();
}

// ── Comeback config loader ────────────────────────────────────────────────────

async function getComebackConfig(sheets) {
  const data = await getSheetData(sheets, 'Config');
  const cfg  = {};
  for (let i = 1; i < data.length; i++) {
    if (data[i][0]) cfg[data[i][0]] = (data[i][1] || '').toString().trim();
  }
  return cfg;
}

// ── PHT date string ───────────────────────────────────────────────────────────

function getPHTDateString() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
}

// ── Compute day number from release date ──────────────────────────────────────

function getDayNumber(releaseDateStr) {
  if (!releaseDateStr) return null;
  const release = new Date(releaseDateStr);
  const now     = new Date(getPHTDateString());
  const diff    = Math.floor((now - release) / 86400000);
  return diff + 1; // D1 = release day
}

// ── Compute week number from release date ─────────────────────────────────────

function getWeekNumber(releaseDateStr) {
  const day = getDayNumber(releaseDateStr);
  if (!day || day < 1) return null;
  return Math.ceil(day / 7);
}

function isWeekBoundary(releaseDateStr) {
  const day = getDayNumber(releaseDateStr);
  if (!day) return false;
  return day > 0 && day % 7 === 0;
}

// ── Read daily history from Raw Scrape Log ────────────────────────────────────

function getDailyHistory(rawScrapeLog, trackName, platform) {
  const entries = [];
  for (let i = 1; i < rawScrapeLog.length; i++) {
    const row = rawScrapeLog[i];
    if ((row[1] || '') === trackName && (row[3] || '') === platform) {
      entries.push({
        timestamp: row[0],
        streams:   parseInt((row[5] || '0').toString().replace(/,/g, ''), 10)
      });
    }
  }

  // Deduplicate to one entry per calendar day PHT, keeping last entry
  const byDay = {};
  for (const e of entries) {
    const day = new Date(e.timestamp).toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
    byDay[day] = e;
  }

  return Object.entries(byDay)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v], idx) => ({ ...v, day: idx + 1 }));
}

// ── Format goal line ──────────────────────────────────────────────────────────

function formatGoalLine(currentStreams, goalStr, label) {
  if (!goalStr) return null;
  const goal      = parseInt(goalStr.replace(/,/g, ''), 10);
  if (isNaN(goal) || goal === 0) return null;
  const reached   = currentStreams >= goal;
  const emoji     = reached ? '✅' : '🏁';
  const formatted = formatMilestoneNumber(goal);
  return `${emoji}${label} : ${formatted}`;
}

// ── Build daily thread post (track) ──────────────────────────────────────────

function buildDailyTrackPost(config, trackName, history, spotifyUrl, songHashtags, goalStr) {
  const MAX_CHARS   = 280;
  const closingTags = buildClosingTags(config);
  const header      = `[SPOTIFY] — ${config.handle} '${trackName}' daily streams`;

  const dayLines = history.map((entry, i) => {
    if (i === 0) return { base: `D${entry.day} - ${entry.streams.toLocaleString()}`, delta: '' };
    const delta    = entry.streams - history[i - 1].streams;
    const prevDelta = i >= 2 ? history[i - 1].streams - history[i - 2].streams : null;
    let emoji = '';
    if (prevDelta !== null) emoji = delta > prevDelta ? ' 🔥' : ' ⚠️';
    return {
      base:  `D${entry.day} - ${entry.streams.toLocaleString()}`,
      delta: ` (+${delta.toLocaleString()})${emoji}`
    };
  });

  const currentStreams = history[history.length - 1]?.streams || 0;
  const goalLine       = formatGoalLine(currentStreams, goalStr, 'First Week Goal');

  const footerParts = [spotifyUrl, goalLine, songHashtags, config.tags, closingTags].filter(Boolean);
  const footerLines = footerParts.join('\n');

  function assemblePost(lines) {
    return [header, '', ...lines, '', footerLines].join('\n').trim();
  }

  let assembled = dayLines.map(l => l.base + l.delta);
  let post      = assemblePost(assembled);

  let i = 1;
  while (post.length > MAX_CHARS && i < assembled.length) {
    assembled[i] = dayLines[i].base;
    post         = assemblePost(assembled);
    i++;
  }

  return post;
}

// ── Build daily thread post (album) ──────────────────────────────────────────

function buildDailyAlbumPost(config, albumName, albumType, history, albumSpotifyUrl, albumHashtags, goalStr) {
  const MAX_CHARS   = 280;
  const closingTags = buildClosingTags(config);
  const header      = `[SPOTIFY] — ${config.handle} ${albumType} '${albumName}' Total Streams:`;

  const dayLines = history.map((entry, i) => {
    if (i === 0) return { base: `D${entry.day} — ${entry.streams.toLocaleString()}`, delta: '' };
    const delta    = entry.streams - history[i - 1].streams;
    const prevDelta = i >= 2 ? history[i - 1].streams - history[i - 2].streams : null;
    let emoji = '';
    if (prevDelta !== null) emoji = delta > prevDelta ? ' 🔥' : ' ⚠️';
    return {
      base:  `D${entry.day} — ${entry.streams.toLocaleString()}`,
      delta: ` (+${delta.toLocaleString()})${emoji}`
    };
  });

  const currentStreams = history[history.length - 1]?.streams || 0;
  const goalLine       = formatGoalLine(currentStreams, goalStr, 'First Week Goal');

  const footerParts = [albumSpotifyUrl ? `🔗${albumSpotifyUrl}` : null, goalLine, albumHashtags, config.tags, closingTags].filter(Boolean);
  const footerLines = footerParts.join('\n');

  function assemblePost(lines) {
    return [header, '', ...lines, '', footerLines].join('\n').trim();
  }

  let assembled = dayLines.map(l => l.base + l.delta);
  let post      = assemblePost(assembled);

  let i = 1;
  while (post.length > MAX_CHARS && i < assembled.length) {
    assembled[i] = dayLines[i].base;
    post         = assemblePost(assembled);
    i++;
  }

  return post;
}

// ── Build weekly post ─────────────────────────────────────────────────────────

function buildWeeklyPost(config, trackOrAlbumName, isAlbum, albumType, weeklyTotals, spotifyUrl, hashtagsLine, closingTags, goalStr) {
  const MAX_CHARS = 280;
  const label     = isAlbum
    ? `${config.handle} ${albumType} '${trackOrAlbumName}' Total Streams:`
    : `${config.handle} '${trackOrAlbumName}' streams:`;
  const header    = `[SPOTIFY] — ${label}`;

  const weekLines = weeklyTotals.map((entry, i) => {
    if (i === 0) return { base: `WEEK ${entry.week} — ${entry.total.toLocaleString()}`, delta: '' };
    const delta = entry.total - weeklyTotals[i - 1].total;
    return {
      base:  `WEEK ${entry.week} — ${entry.total.toLocaleString()}`,
      delta: ` (+${delta.toLocaleString()})`
    };
  });

  const currentStreams = weeklyTotals[weeklyTotals.length - 1]?.total || 0;
  const goalLine       = formatGoalLine(currentStreams, goalStr, 'First Week Goal');

  const footerParts = [spotifyUrl ? `🔗${spotifyUrl}` : null, goalLine, hashtagsLine, closingTags].filter(Boolean);
  const footerLines = footerParts.join('\n');

  function assemblePost(lines) {
    return [header, '', ...lines, '', footerLines].join('\n').trim();
  }

  let assembled = weekLines.map(l => l.base + l.delta);
  let post      = assemblePost(assembled);

  let i = 1;
  while (post.length > MAX_CHARS && i < assembled.length) {
    assembled[i] = weekLines[i].base;
    post         = assemblePost(assembled);
    i++;
  }

  return post;
}

// ── Compute weekly totals from daily history ──────────────────────────────────

function computeWeeklyTotals(history, currentWeek) {
  const result = [];
  for (let w = 1; w <= currentWeek; w++) {
    // Last entry of each week
    const weekEntries = history.filter(e => Math.ceil(e.day / 7) === w);
    if (weekEntries.length === 0) continue;
    const last = weekEntries[weekEntries.length - 1];
    result.push({ week: w, total: last.streams });
  }
  return result;
}

// ── Send to Discord ───────────────────────────────────────────────────────────

async function sendToWebhook(webhookUrl, payload) {
  const response = await fetch(webhookUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload)
  });

  if (response.status === 429) {
    const retryAfter = parseInt(response.headers.get('retry-after') || '5', 10);
    console.log(`Rate limited. Waiting ${retryAfter}s...`);
    await new Promise(r => setTimeout(r, retryAfter * 1000));
    await fetch(webhookUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload)
    });
  } else if (!response.ok) {
    console.error(`Discord webhook error: ${response.status}`);
  }
  await new Promise(r => setTimeout(r, 2000));
}

async function sendComebackPost(post, title) {
  await sendToWebhook(process.env.DISCORD_MILESTONE_WEBHOOK, {
    embeds: [{
      title,
      color:  1947988,
      description: post,
      footer: { text: '✅ Approve and post manually to X | ❌ Discard' }
    }]
  });
}

// ── Milestone dedup (in-memory) ───────────────────────────────────────────────

function isMilestoneLogged(existingMilestones, trackName, platform, milestoneValue, countType) {
  for (let i = 1; i < existingMilestones.length; i++) {
    if (
      existingMilestones[i][1] === trackName &&
      existingMilestones[i][3] === platform &&
      parseInt((existingMilestones[i][4] || '').toString().replace(/,/g, ''), 10) === milestoneValue &&
      existingMilestones[i][5] === countType
    ) return true;
  }
  return false;
}

function cacheMilestone(existingMilestones, trackName, album, platform, milestoneValue, countType, sourceUrl) {
  existingMilestones.push(['', trackName, album, platform, milestoneValue, countType, sourceUrl, '', '']);
}

async function persistMilestone(sheets, trackName, album, platform, milestoneValue, countType, sourceUrl) {
  await appendSheetRow(sheets, 'Milestones Achieved', [
    getPHTTimestamp(), trackName, album, platform, milestoneValue, countType, sourceUrl, '', ''
  ]);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Starting Spotify scraper... (jitter: ${JITTER_MS}ms)`);
  await new Promise(r => setTimeout(r, JITTER_MS));

  const sheets     = await getSheetsClient();
  const isComeback = await getComebackMode(sheets);
  console.log(`Mode: ${isComeback ? 'COMEBACK' : 'NORMAL'}`);

  // Normal mode: Saturdays only
  if (!isComeback) {
    const dayOfWeek = new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila', weekday: 'long' });
    if (dayOfWeek !== 'Saturday') {
      console.log(`Normal mode — today is ${dayOfWeek}, skipping.`);
      return;
    }
  }

  const registryData       = await getSheetData(sheets, 'Master Registry');
  const existingMilestones = await getSheetData(sheets, 'Milestones Achieved');
  const rawScrapeLog       = isComeback ? await getSheetData(sheets, 'Raw Scrape Log') : [];
  const milestones         = [];
  const rawLogBuffer       = [];
  const unmatchedBuffer    = [];
  const processedTracks    = new Set();

  // ── Comeback config ───────────────────────────────────────────────────────
  let cfg             = {};
  let comebackTrack   = '';
  let comebackAlbum   = '';
  let releaseDate     = '';
  let isAlbum         = false;
  let albumKworbUrl   = '';
  let albumSpotifyUrl = '';
  let trackSpotifyUrl = '';
  let albumSpotifyGoal = '';
  let trackSpotifyGoal = '';
  let dayNumber       = null;
  let weekNumber      = null;
  let albumType       = '';

  if (isComeback) {
    cfg              = await getComebackConfig(sheets);
    comebackTrack    = cfg['COMEBACK_TRACK']              || '';
    comebackAlbum    = cfg['COMEBACK_ALBUM']              || '';
    releaseDate      = cfg['COMEBACK_RELEASE_DATE']       || '';
    isAlbum          = cfg['COMEBACK_IS_ALBUM']?.toUpperCase() === 'YES';
    albumKworbUrl    = cfg['COMEBACK_ALBUM_KWORB_URL']    || '';
    albumSpotifyUrl  = cfg['COMEBACK_ALBUM_SPOTIFY_URL']  || '';
    trackSpotifyUrl  = cfg['COMEBACK_SPOTIFY_URL']        || '';
    albumSpotifyGoal = cfg['COMEBACK_ALBUM_SPOTIFY_GOAL'] || '';
    trackSpotifyGoal = cfg['COMEBACK_SPOTIFY_GOAL']       || '';
    dayNumber        = getDayNumber(releaseDate);
    weekNumber       = getWeekNumber(releaseDate);
    albumType        = cfg['COMEBACK_ALBUM_TYPE']         || 'Album'; // e.g. "2nd Mini Album"
    console.log(`Comeback: "${comebackTrack}" | Day ${dayNumber} | Week ${weekNumber}`);
  }

  // ── Scrape all artist pages ───────────────────────────────────────────────
  const scrapedStreams = {}; // trackName -> streams

  for (const artist of ARTIST_PAGES) {
    console.log(`Scraping: ${artist.label}`);
    let html;
    try {
      html = await scrapePage(artist.url);
    } catch (e) {
      console.error(`Fetch error for ${artist.label}: ${e.message}`);
      continue;
    }

    const tracks = parseKworbTable(html);
    console.log(`  Found ${tracks.length} tracks`);

    for (const track of tracks) {
      if (track.streams < 10000000) continue;

      const match = findMatchInRegistry(track.title, registryData);
      if (!match) {
        unmatchedBuffer.push([getPHTTimestamp(), track.title, track.streams, track.daily, artist.label]);
        await flagNewRelease(sheets, track.title, artist.label, 'Spotify/kworb', artist.url);
        continue;
      }

      const matchedRow     = match.row;
      const trackName      = matchedRow[0];
      const album          = matchedRow[2];
      const activeTracking = (matchedRow[11] || '').toString().trim().toLowerCase();
      if (activeTracking !== 'yes') continue;

      const trackKey = `${trackName}|Spotify`;
      if (processedTracks.has(trackKey)) continue;
      processedTracks.add(trackKey);

      scrapedStreams[trackName] = track.streams;

      const memberConfig = getMemberConfig(matchedRow);
      const spotifyUri   = matchedRow[12];
      const spotifyUrl   = spotifyUri
        ? 'https://open.spotify.com/track/' + spotifyUri.replace('spotify:track:', '')
        : `https://open.spotify.com/search/${encodeURIComponent(trackName)}`;

      rawLogBuffer.push([
        getPHTTimestamp(), trackName, album, 'Spotify', 'Streams',
        track.streams, '', artist.url
      ]);

      // ── Normal milestone check (all modes) ─────────────────────────────
      const interval       = 10000000;
      const lastMilestone  = Math.floor(track.streams / interval) * interval;
      if (lastMilestone > 0) {
        if (!isMilestoneLogged(existingMilestones, trackName, 'Spotify', lastMilestone, 'Streams')) {
          cacheMilestone(existingMilestones, trackName, album, 'Spotify', lastMilestone, 'Streams', spotifyUrl);
          await persistMilestone(sheets, trackName, album, 'Spotify', lastMilestone, 'Streams', spotifyUrl);
          milestones.push({
            trackName, album, platform: 'Spotify', milestone: lastMilestone,
            countType: 'Streams', sourceUrl: spotifyUrl, memberConfig,
            songHashtags: (matchedRow[17] || '').trim()
          });
        }
      }
    }

    await new Promise(r => setTimeout(r, 2000));
  }

  // ── Comeback: album kworb page ────────────────────────────────────────────
  let albumTotalStreams = 0;
  const albumTrackStreams = {}; // trackName -> streams for album tracks

  if (isComeback && isAlbum && albumKworbUrl) {
    console.log(`Scraping album kworb page: ${albumKworbUrl}`);
    try {
      const html   = await scrapePage(albumKworbUrl);
      const tracks = parseKworbTable(html);

      for (const track of tracks) {
        const match = findMatchInRegistry(track.title, registryData);
        if (!match) continue;

        const matchedRow  = match.row;
        const trackName   = matchedRow[0];
        const albumName   = matchedRow[2];
        const activeTracking = (matchedRow[11] || '').toString().trim().toLowerCase();
        if (activeTracking !== 'yes') continue;
        if (albumName !== comebackAlbum) continue;

        albumTrackStreams[trackName] = track.streams;
        albumTotalStreams += track.streams;

        // Log album tracks to Raw Scrape Log if not already logged from artist pages
        if (!processedTracks.has(`${trackName}|Spotify`)) {
          rawLogBuffer.push([
            getPHTTimestamp(), trackName, albumName, 'Spotify', 'Streams',
            track.streams, '', albumKworbUrl
          ]);
          processedTracks.add(`${trackName}|Spotify`);
        }
      }

      // Log album total
      rawLogBuffer.push([
        getPHTTimestamp(), comebackAlbum, comebackAlbum, 'Spotify', 'Album Streams',
        albumTotalStreams, '', albumKworbUrl
      ]);

      console.log(`Album total streams: ${albumTotalStreams.toLocaleString()}`);
    } catch (e) {
      console.error(`Album kworb fetch error: ${e.message}`);
    }
  }

  // ── Send normal milestones ────────────────────────────────────────────────
  await sendDiscordDraft(milestones);

  // ── Comeback daily/weekly posts ───────────────────────────────────────────
  if (isComeback && dayNumber && dayNumber >= 1) {
    const isDaily  = dayNumber <= 14;
    const isWeekly = !isDaily && weekNumber >= 2 && weekNumber <= 4 && isWeekBoundary(releaseDate);

    // Find comeback track registry row
    let comebackTrackRow = null;
    for (let i = 1; i < registryData.length; i++) {
      if ((registryData[i][0] || '').trim() === comebackTrack) {
        comebackTrackRow = registryData[i];
        break;
      }
    }

    if (comebackTrackRow) {
      const memberConfig  = getMemberConfig(comebackTrackRow);
      const songHashtags  = (comebackTrackRow[17] || '').trim();
      const albumHashtags = (comebackTrackRow[18] || '').trim();

      const trackSpotifyUri = comebackTrackRow[12];
      const resolvedTrackUrl = trackSpotifyUri
        ? 'https://open.spotify.com/track/' + trackSpotifyUri.replace('spotify:track:', '')
        : trackSpotifyUrl;

      // ── Daily track post ──────────────────────────────────────────────
      if (isDaily) {
        const trackHistory = getDailyHistory(rawScrapeLog, comebackTrack, 'Spotify');

        // Add today's scraped value if available and not already in log
        const todayStr = getPHTDateString();
        const alreadyToday = trackHistory.some(e =>
          new Date(e.timestamp).toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' }) === todayStr
        );
        if (!alreadyToday && scrapedStreams[comebackTrack]) {
          trackHistory.push({ day: dayNumber, streams: scrapedStreams[comebackTrack], timestamp: new Date().toISOString() });
        }

        if (trackHistory.length > 0) {
          const post = buildDailyTrackPost(
            memberConfig, comebackTrack, trackHistory,
            resolvedTrackUrl, songHashtags, trackSpotifyGoal
          );
          await sendComebackPost(post, `📊 SPOTIFY DAILY — ${comebackTrack} D${dayNumber} — Pending Approval`);
          console.log(`Sent daily track post: D${dayNumber}`);
        }

        // ── Daily album post ────────────────────────────────────────────
        if (isAlbum && albumTotalStreams > 0) {
          const albumHistory = getDailyHistory(rawScrapeLog, comebackAlbum, 'Spotify');

          const alreadyTodayAlbum = albumHistory.some(e =>
            new Date(e.timestamp).toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' }) === todayStr
          );
          if (!alreadyTodayAlbum) {
            albumHistory.push({ day: dayNumber, streams: albumTotalStreams, timestamp: new Date().toISOString() });
          }

          const post = buildDailyAlbumPost(
            memberConfig, comebackAlbum, albumType, albumHistory,
            albumSpotifyUrl, albumHashtags, albumSpotifyGoal
          );
          await sendComebackPost(post, `📊 SPOTIFY DAILY — ${comebackAlbum} D${dayNumber} — Pending Approval`);
          console.log(`Sent daily album post: D${dayNumber}`);
        }
      }

      // ── Weekly track post ─────────────────────────────────────────────
      if (isWeekly) {
        const trackHistory  = getDailyHistory(rawScrapeLog, comebackTrack, 'Spotify');
        const weeklyTotals  = computeWeeklyTotals(trackHistory, weekNumber);

        if (weeklyTotals.length > 0) {
          const closingTags = buildClosingTags(memberConfig);
          const post = buildWeeklyPost(
            memberConfig, comebackTrack, false, '', weeklyTotals,
            resolvedTrackUrl, songHashtags, closingTags, trackSpotifyGoal
          );
          await sendComebackPost(post, `📊 SPOTIFY WEEK ${weekNumber} — ${comebackTrack} — Pending Approval`);
          console.log(`Sent weekly track post: W${weekNumber}`);
        }

        // ── Weekly album post ───────────────────────────────────────────
        if (isAlbum) {
          const albumHistory = getDailyHistory(rawScrapeLog, comebackAlbum, 'Spotify');
          const albumWeekly  = computeWeeklyTotals(albumHistory, weekNumber);

          if (albumWeekly.length > 0) {
            const closingTags = buildClosingTags(memberConfig);
            const post = buildWeeklyPost(
              memberConfig, comebackAlbum, true, albumType, albumWeekly,
              albumSpotifyUrl, albumHashtags, closingTags, albumSpotifyGoal
            );
            await sendComebackPost(post, `📊 SPOTIFY WEEK ${weekNumber} — ${comebackAlbum} — Pending Approval`);
            console.log(`Sent weekly album post: W${weekNumber}`);
          }
        }
      }
    }
  }

  // ── Write logs ────────────────────────────────────────────────────────────
  console.log(`Writing ${rawLogBuffer.length} rows to Raw Scrape Log...`);
  await batchAppendRows(sheets, 'Raw Scrape Log', rawLogBuffer);

  if (unmatchedBuffer.length > 0) {
    console.log(`Writing ${unmatchedBuffer.length} unmatched rows...`);
    await batchAppendRows(sheets, 'Unmatched Tracks', unmatchedBuffer);
  }

  console.log('Spotify scraper complete.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
