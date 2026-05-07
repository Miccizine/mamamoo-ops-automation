const {
  getSheetsClient,
  getSheetData,
  batchAppendRows,
  appendSheetRow,
  getMemberConfig,
  checkMilestone,
  sendDiscordDraft,
  getComebackMode,
  getPHTTimestamp,
  formatMilestoneNumber,
  buildClosingTags
} = require('./helpers');

const fetch = require('node-fetch');

// ── YouTube API ───────────────────────────────────────────────────────────────

async function getYouTubeStatsBatch(videoIds) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  const ids    = videoIds.join(',');
  const url    = `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${ids}&key=${apiKey}`;

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const statsMap = {};
    if (data.items) {
      data.items.forEach(item => {
        statsMap[item.id] = item.statistics;
      });
    }
    console.log(`Batch: ${videoIds.length} requested | ${Object.keys(statsMap).length} returned`);
    return statsMap;
  } catch(e) {
    console.error(`YouTube API error: ${e.message}`);
    return {};
  }
}

// ── Milestone Interval Logic ──────────────────────────────────────────────────

function getYouTubeInterval(currentCount, isComeback, isComebackTrack) {
  if (isComeback && isComebackTrack) return 1000000;   // 1M during comeback
  if (currentCount >= 100000000) return 5000000;        // 5M at 100M+
  return 10000000;                                       // 10M standard
}

// ── Overflow Queue ────────────────────────────────────────────────────────────

async function saveOverflowToQueue(sheets, overflowMilestones) {
  if (overflowMilestones.length === 0) return;
  const rows = overflowMilestones.map(m => [
    getPHTTimestamp(),
    m.trackName,
    m.album,
    m.platform,
    m.milestone,
    m.countType,
    m.sourceUrl,
    JSON.stringify(m.memberConfig)
  ]);
  await batchAppendRows(sheets, 'Milestone Queue', rows);
  console.log(`Queued ${overflowMilestones.length} overflow milestones`);
}

async function processOverflowQueue(sheets) {
  const queueData = await getSheetData(sheets, 'Milestone Queue');
  if (queueData.length <= 1) return [];

  const queued = [];
  for (let i = 1; i < queueData.length; i++) {
    const row = queueData[i];
    if (!row[1]) continue;
    try {
      queued.push({
        trackName:    row[1],
        album:        row[2],
        platform:     row[3],
        milestone:    parseInt(row[4]),
        countType:    row[5],
        sourceUrl:    row[6],
        memberConfig: JSON.parse(row[7])
      });
    } catch(e) {
      console.error(`Queue parse error row ${i}: ${e.message}`);
    }
  }

  // Clear the queue
  if (queueData.length > 1) {
    await sheets.spreadsheets.values.clear({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range:         'Milestone Queue!A2:H'
    });
  }

  console.log(`Loaded ${queued.length} items from overflow queue`);
  return queued;
}

// ── Custom Milestone Check for YouTube ───────────────────────────────────────
// Handles variable intervals unlike the standard checkMilestone in helpers

async function checkYouTubeMilestone(sheets, trackName, album, countType, currentCount, sourceUrl, memberConfig, isComeback, isComebackTrack) {
  const interval     = getYouTubeInterval(currentCount, isComeback, isComebackTrack);
  const lastMilestone = Math.floor(currentCount / interval) * interval;
  if (lastMilestone === 0) return null;

  const existing = await getSheetData(sheets, 'Milestones Achieved');
  for (let i = 1; i < existing.length; i++) {
    if (existing[i][1] === trackName &&
        existing[i][3] === 'YouTube' &&
        parseInt(existing[i][4]) === lastMilestone) {
      return null;
    }
  }

  console.log(`New milestone: ${trackName} | YouTube | ${lastMilestone}`);

  await appendSheetRow(sheets, 'Milestones Achieved', [
    getPHTTimestamp(),
    trackName,
    album,
    'YouTube',
    lastMilestone,
    countType,
    sourceUrl,
    '',
    ''
  ]);

  return {
    trackName,
    album,
    platform:     'YouTube',
    milestone:    lastMilestone,
    countType,
    sourceUrl,
    memberConfig
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Starting YouTube scraper...');

  const sheets       = await getSheetsClient();
  const isComeback   = await getComebackMode(sheets);
  console.log(`Mode: ${isComeback ? 'COMEBACK' : 'NORMAL'}`);

  // Adjust schedule in comeback mode — runs every 6 hours via workflow
  // In normal mode runs every 12 hours — both handled by cron, no skip logic needed

  const registryData = await getSheetData(sheets, 'Master Registry');
  const configData   = await getSheetData(sheets, 'Config');

  // Read comeback track from config
  let comebackTrack = '';
  for (let i = 1; i < configData.length; i++) {
    if (configData[i][0] === 'COMEBACK_TRACK') {
      comebackTrack = configData[i][1] || '';
      break;
    }
  }

  const milestones      = [];
  const rawLogBuffer    = [];
  const videoQueue      = [];
  const seenVideoIds    = new Set();
  const seenTrackUrls   = new Map(); // trackName → [videoIds] for combined view calc

  // Build video queue from registry
  for (let i = 1; i < registryData.length; i++) {
    const row            = registryData[i];
    const trackName      = row[0] ? row[0].toString().trim() : '';
    const album          = row[2] ? row[2].toString().trim() : '';
    const activeTracking = row[11] ? row[11].toString().trim().toLowerCase() : '';

    if (!trackName || activeTracking !== 'yes') continue;

    const urls = [
      row[13] ? row[13].toString().trim() : '',  // Column N
      row[14] ? row[14].toString().trim() : '',  // Column O
      row[15] ? row[15].toString().trim() : ''   // Column P
    ].filter(u => u !== '');

    if (urls.length === 0) continue;

    const memberConfig      = getMemberConfig(row);
    const isComebackTrack   = isComeback && comebackTrack &&
                              trackName.toLowerCase() === comebackTrack.toLowerCase();
    const validVideoIds     = [];

    for (const url of urls) {
      const match = url.match(/(?:v=|youtu\.be\/)([^&\n?#]+)/);
      if (!match) continue;
      const videoId = match[1];
      if (seenVideoIds.has(videoId)) continue;
      seenVideoIds.add(videoId);
      validVideoIds.push(videoId);
      videoQueue.push({
        videoId,
        trackName,
        album,
        memberConfig,
        isComebackTrack,
        sourceUrl: `https://youtube.com/watch?v=${videoId}`
      });
    }

    if (validVideoIds.length > 0) {
      seenTrackUrls.set(trackName, validVideoIds);
    }
  }

  console.log(`Video queue: ${videoQueue.length} videos across ${seenTrackUrls.size} tracks`);

  // Fetch stats in batches of 50
  const viewsByVideoId = {};

  for (let b = 0; b < videoQueue.length; b += 50) {
    const batch    = videoQueue.slice(b, b + 50);
    const videoIds = batch.map(v => v.videoId);
    const statsMap = await getYouTubeStatsBatch(videoIds);

    for (const item of batch) {
      const stats = statsMap[item.videoId];
      if (!stats) continue;

      const viewCount = parseInt(stats.viewCount || '0', 10);
      const likeCount = parseInt(stats.likeCount || '0', 10);
      if (!viewCount) continue;

      viewsByVideoId[item.videoId] = {
        viewCount,
        likeCount,
        trackName:      item.trackName,
        album:          item.album,
        memberConfig:   item.memberConfig,
        isComebackTrack: item.isComebackTrack,
        sourceUrl:      item.sourceUrl
      };
    }

    await new Promise(r => setTimeout(r, 500));
  }

  // Group by track for combined view calculation
  const processedTracks = new Set();

  for (const [trackName, videoIds] of seenTrackUrls.entries()) {
    if (processedTracks.has(trackName)) continue;
    processedTracks.add(trackName);

    const trackVideos = videoIds
      .map(id => viewsByVideoId[id])
      .filter(Boolean);

    if (trackVideos.length === 0) continue;

    const primary        = trackVideos[0];
    const hasMultiple    = trackVideos.length > 1;
    const totalViews     = trackVideos.reduce((sum, v) => sum + v.viewCount, 0);
    const milestoneCount = hasMultiple ? totalViews : primary.viewCount;
    const countType      = hasMultiple ? 'Combined Views' : 'Views';

    // Log all individual URLs to Raw Scrape Log
    for (let i = 0; i < trackVideos.length; i++) {
      const v = trackVideos[i];
      rawLogBuffer.push([
        getPHTTimestamp(),
        trackName,
        primary.album,
        'YouTube',
        'Views',
        v.viewCount,
        i === 0 && hasMultiple ? totalViews : '',
        v.sourceUrl
      ]);

      // Log likes separately for primary URL
      if (i === 0) {
        rawLogBuffer.push([
          getPHTTimestamp(),
          trackName,
          primary.album,
          'YouTube',
          'Likes',
          v.likeCount,
          '',
          v.sourceUrl
        ]);
      }
    }

    // Check view milestone
    const viewMilestone = await checkYouTubeMilestone(
      sheets,
      trackName,
      primary.album,
      countType,
      milestoneCount,
      primary.sourceUrl,
      primary.memberConfig,
      isComeback,
      primary.isComebackTrack
    );
    if (viewMilestone) milestones.push(viewMilestone);

    // Check likes milestone (every 1M normal, every 100K comeback)
    const likesInterval  = isComeback && primary.isComebackTrack ? 100000 : 1000000;
    const likesMilestone = Math.floor(primary.viewCount / likesInterval) * likesInterval;

    if (likesMilestone > 0) {
      const existingMilestones = await getSheetData(sheets, 'Milestones Achieved');
      const likesDuplicate = existingMilestones.slice(1).some(row =>
        row[1] === trackName &&
        row[3] === 'YouTube' &&
        row[5] === 'Likes' &&
        parseInt(row[4]) === likesMilestone
      );

      if (!likesDuplicate) {
        await appendSheetRow(sheets, 'Milestones Achieved', [
          getPHTTimestamp(),
          trackName,
          primary.album,
          'YouTube',
          likesMilestone,
          'Likes',
          primary.sourceUrl,
          '',
          ''
        ]);

        milestones.push({
          trackName,
          album:        primary.album,
          platform:     'YouTube',
          milestone:    likesMilestone,
          countType:    'Likes',
          sourceUrl:    primary.sourceUrl,
          memberConfig: primary.memberConfig
        });
      }
    }
  }

  // Write raw log
  if (rawLogBuffer.length > 0) {
    console.log(`Writing ${rawLogBuffer.length} rows to Raw Scrape Log...`);
    await batchAppendRows(sheets, 'Raw Scrape Log', rawLogBuffer);
  }

  // Process overflow queue from previous runs
  const queuedMilestones = await processOverflowQueue(sheets);
  const allMilestones    = [...queuedMilestones, ...milestones];

  // Send up to 10 per run, queue the rest
  const MAX_SEND  = 10;
  const toSend    = allMilestones.slice(0, MAX_SEND);
  const overflow  = allMilestones.slice(MAX_SEND);

  if (overflow.length > 0) {
    await saveOverflowToQueue(sheets, overflow);
  }

  console.log(`Milestones: ${milestones.length} new | ${queuedMilestones.length} queued | Sending: ${toSend.length}`);
  await sendDiscordDraft(toSend);

  console.log('YouTube scraper complete.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
