const {
  getSheetsClient,
  getSheetData,
  batchAppendRows,
  getMemberConfig,
  sendDiscordDraft,
  getComebackMode,
  getPHTTimestamp
} = require('./helpers');

const fetch = require('node-fetch');

// ── YouTube API ───────────────────────────────────────────────────────────────

async function getYouTubeStatsBatch(videoIds) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  const ids = videoIds.join(',');

  console.log(`Requesting batch: ${ids}`);

  const url =
    `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${ids}&key=${apiKey}`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status} | ${errorText}`);
    }

    const data = await response.json();

    const statsMap = {};

    if (data.items) {
      data.items.forEach(item => {
        statsMap[item.id] = item.statistics;
      });
    }

    console.log(
      `Batch: ${videoIds.length} requested | ${Object.keys(statsMap).length} returned`
    );

    return statsMap;

  } catch (e) {
    console.error(`YouTube API error: ${e.message}`);
    return {};
  }
}

// ── Video ID Utilities ────────────────────────────────────────────────────────

function extractYouTubeVideoId(url) {
  try {
    const parsed = new URL(url);

    // youtu.be short links
    if (parsed.hostname.includes('youtu.be')) {
      return parsed.pathname.slice(1);
    }

    // standard watch URLs
    const v = parsed.searchParams.get('v');
    if (v) return v;

    // shorts/live/embed
    const paths = parsed.pathname.split('/').filter(Boolean);

    const specialIndex = paths.findIndex(p =>
      ['shorts', 'live', 'embed'].includes(p)
    );

    if (specialIndex !== -1 && paths[specialIndex + 1]) {
      return paths[specialIndex + 1];
    }

    return null;

  } catch {
    return null;
  }
}

function isValidYouTubeVideoId(id) {
  return /^[a-zA-Z0-9_-]{11}$/.test(id);
}

// ── Milestone Logic ───────────────────────────────────────────────────────────

function getYouTubeInterval(currentCount, isComeback, isComebackTrack) {
  if (isComeback && isComebackTrack) return 1000000;
  if (currentCount >= 100000000) return 5000000;
  return 10000000;
}

function buildMilestoneKey(trackName, platform, milestone, countType) {
  return `${trackName}__${platform}__${milestone}__${countType}`;
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
        trackName: row[1],
        album: row[2],
        platform: row[3],
        milestone: parseInt(row[4]),
        countType: row[5],
        sourceUrl: row[6],
        memberConfig: JSON.parse(row[7])
      });

    } catch (e) {
      console.error(`Queue parse error row ${i}: ${e.message}`);
    }
  }

  // Clear queue
  if (queueData.length > 1) {
    await sheets.spreadsheets.values.clear({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: 'Milestone Queue!A2:H'
    });
  }

  console.log(`Loaded ${queued.length} items from overflow queue`);

  return queued;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Starting YouTube scraper...');

  const sheets = await getSheetsClient();

  const isComeback = await getComebackMode(sheets);

  console.log(`Mode: ${isComeback ? 'COMEBACK' : 'NORMAL'}`);

  // ── Load Sheets Once ───────────────────────────────────────────────────────

  const [
    registryData,
    configData,
    achievedData
  ] = await Promise.all([
    getSheetData(sheets, 'Master Registry'),
    getSheetData(sheets, 'Config'),
    getSheetData(sheets, 'Milestones Achieved')
  ]);

  // ── Build Existing Milestone Cache ─────────────────────────────────────────

  const achievedSet = new Set();

  for (let i = 1; i < achievedData.length; i++) {
    const row = achievedData[i];

    achievedSet.add(
      buildMilestoneKey(
        row[1],
        row[3],
        parseInt(row[4]),
        row[5]
      )
    );
  }

  // ── Read Comeback Track ────────────────────────────────────────────────────

  let comebackTrack = '';

  for (let i = 1; i < configData.length; i++) {
    if (configData[i][0] === 'COMEBACK_TRACK') {
      comebackTrack = configData[i][1] || '';
      break;
    }
  }

  // ── Buffers ────────────────────────────────────────────────────────────────

  const milestones = [];
  const rawLogBuffer = [];
  const achievedRowsBuffer = [];

  const videoQueue = [];

  const seenVideoIds = new Set();
  const seenTrackUrls = new Map();

  // ── Build Video Queue ──────────────────────────────────────────────────────

  for (let i = 1; i < registryData.length; i++) {
    const row = registryData[i];

    const trackName =
      row[0] ? row[0].toString().trim() : '';

    const album =
      row[2] ? row[2].toString().trim() : '';

    const activeTracking =
      row[11]
        ? row[11].toString().trim().toLowerCase()
        : '';

    if (!trackName || activeTracking !== 'yes') continue;

    const urls = [
      row[13] ? row[13].toString().trim() : '',
      row[14] ? row[14].toString().trim() : '',
      row[15] ? row[15].toString().trim() : ''
    ].filter(Boolean);

    if (urls.length === 0) continue;

    const memberConfig = getMemberConfig(row);

    const isComebackTrack =
      isComeback &&
      comebackTrack &&
      trackName.toLowerCase() === comebackTrack.toLowerCase();

    const validVideoIds = [];

    for (const url of urls) {
      const videoId = extractYouTubeVideoId(url);

      if (!videoId || !isValidYouTubeVideoId(videoId)) {
        console.log(`Invalid YouTube URL skipped: ${url}`);
        continue;
      }

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

  console.log(
    `Video queue: ${videoQueue.length} videos across ${seenTrackUrls.size} tracks`
  );

  // ── Fetch Stats ────────────────────────────────────────────────────────────

  const viewsByVideoId = {};

  for (let b = 0; b < videoQueue.length; b += 50) {
    const batch = videoQueue.slice(b, b + 50);

    const videoIds = batch.map(v => v.videoId);

    if (videoIds.length === 0) continue;

    const statsMap = await getYouTubeStatsBatch(videoIds);

    for (const item of batch) {
      const stats = statsMap[item.videoId];

      if (!stats) continue;

      const viewCount =
        parseInt(stats.viewCount || '0', 10);

      const likeCount =
        parseInt(stats.likeCount || '0', 10);

      if (!viewCount) continue;

      viewsByVideoId[item.videoId] = {
        viewCount,
        likeCount,
        trackName: item.trackName,
        album: item.album,
        memberConfig: item.memberConfig,
        isComebackTrack: item.isComebackTrack,
        sourceUrl: item.sourceUrl
      };
    }

    await new Promise(r => setTimeout(r, 500));
  }

  // ── Process Tracks ─────────────────────────────────────────────────────────

  const processedTracks = new Set();

  for (const [trackName, videoIds] of seenTrackUrls.entries()) {

    if (processedTracks.has(trackName)) continue;

    processedTracks.add(trackName);

    const trackVideos = videoIds
      .map(id => viewsByVideoId[id])
      .filter(Boolean);

    if (trackVideos.length === 0) continue;

    const primary = trackVideos[0];

    const hasMultiple = trackVideos.length > 1;

    const totalViews = trackVideos.reduce(
      (sum, v) => sum + v.viewCount,
      0
    );

    const milestoneCount =
      hasMultiple
        ? totalViews
        : primary.viewCount;

    const countType =
      hasMultiple
        ? 'Combined Views'
        : 'Views';

    // ── Raw Logs ─────────────────────────────────────────────────────────────

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

    // ── View Milestone ───────────────────────────────────────────────────────

    const interval = getYouTubeInterval(
      milestoneCount,
      isComeback,
      primary.isComebackTrack
    );

    const lastMilestone =
      Math.floor(milestoneCount / interval) * interval;

    if (lastMilestone > 0) {

      const milestoneKey = buildMilestoneKey(
        trackName,
        'YouTube',
        lastMilestone,
        countType
      );

      if (!achievedSet.has(milestoneKey)) {

        achievedSet.add(milestoneKey);

        achievedRowsBuffer.push([
          getPHTTimestamp(),
          trackName,
          primary.album,
          'YouTube',
          lastMilestone,
          countType,
          primary.sourceUrl,
          '',
          ''
        ]);

        milestones.push({
          trackName,
          album: primary.album,
          platform: 'YouTube',
          milestone: lastMilestone,
          countType,
          sourceUrl: primary.sourceUrl,
          memberConfig: primary.memberConfig
        });

        console.log(
          `New milestone: ${trackName} | ${lastMilestone}`
        );
      }
    }

    // ── Likes Milestone ──────────────────────────────────────────────────────

    const likesInterval =
      isComeback && primary.isComebackTrack
        ? 100000
        : 1000000;

    const likesMilestone =
      Math.floor(primary.likeCount / likesInterval) * likesInterval;

    if (likesMilestone > 0) {

      const likesKey = buildMilestoneKey(
        trackName,
        'YouTube',
        likesMilestone,
        'Likes'
      );

      if (!achievedSet.has(likesKey)) {

        achievedSet.add(likesKey);

        achievedRowsBuffer.push([
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
          album: primary.album,
          platform: 'YouTube',
          milestone: likesMilestone,
          countType: 'Likes',
          sourceUrl: primary.sourceUrl,
          memberConfig: primary.memberConfig
        });

        console.log(
          `New likes milestone: ${trackName} | ${likesMilestone}`
        );
      }
    }
  }

  // ── Batch Writes ───────────────────────────────────────────────────────────

  if (achievedRowsBuffer.length > 0) {
    console.log(
      `Writing ${achievedRowsBuffer.length} milestone rows...`
    );

    await batchAppendRows(
      sheets,
      'Milestones Achieved',
      achievedRowsBuffer
    );
  }

  if (rawLogBuffer.length > 0) {
    console.log(
      `Writing ${rawLogBuffer.length} raw log rows...`
    );

    await batchAppendRows(
      sheets,
      'Raw Scrape Log',
      rawLogBuffer
    );
  }

  // ── Queue Handling ─────────────────────────────────────────────────────────

  const queuedMilestones =
    await processOverflowQueue(sheets);

  const allMilestones = [
    ...queuedMilestones,
    ...milestones
  ];

  const MAX_SEND = 10;

  const toSend =
    allMilestones.slice(0, MAX_SEND);

  const overflow =
    allMilestones.slice(MAX_SEND);

  if (overflow.length > 0) {
    await saveOverflowToQueue(
      sheets,
      overflow
    );
  }

  console.log(
    `Milestones: ${milestones.length} new | ` +
    `${queuedMilestones.length} queued | ` +
    `Sending: ${toSend.length}`
  );

  await sendDiscordDraft(toSend);

  console.log('YouTube scraper complete.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
