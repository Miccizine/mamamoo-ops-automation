'use strict';

const {
  getSheetsClient,
  getSheetData,
  batchAppendRows,
  appendSheetRow,
  getMemberConfig,
  getComebackMode,
  getPHTTimestamp,
  buildClosingTags,
  formatMilestoneNumber
} = require('./helpers');

const fetch = require('node-fetch');

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3/videos';
const MAX_IDS_PER_CALL = 50;

// ── Interval logic ────────────────────────────────────────────────────────────

function getMilestoneInterval(currentCount) {
  return currentCount >= 100000000 ? 5000000 : 10000000;
}

function getLastMilestone(currentCount, interval) {
  return Math.floor(currentCount / interval) * interval;
}

// ── YouTube API fetch (batch 50) ──────────────────────────────────────────────

async function fetchYouTubeStats(videoIds) {
  const key = process.env.YOUTUBE_API_KEY;
  const ids = videoIds.join(',');
  const url = `${YOUTUBE_API_BASE}?part=statistics&id=${ids}&key=${key}`;

  const response = await fetch(url);
  if (!response.ok) throw new Error(`YouTube API error: ${response.status}`);

  const data = await response.json();
  const result = {};
  for (const item of (data.items || [])) {
    result[item.id] = {
      views: parseInt(item.statistics.viewCount || '0', 10),
      likes: parseInt(item.statistics.likeCount || '0', 10)
    };
  }
  return result;
}

// ── Extract video ID from URL ─────────────────────────────────────────────────

function extractVideoId(url) {
  if (!url) return null;
  const match = url.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return match ? match[1] : null;
}

// ── Format likes for display (round down to nearest 100) ─────────────────────

function formatLikesDisplay(likes) {
  if (likes >= 1000000) return Math.floor(likes / 100000) / 10 + 'M';
  if (likes >= 1000)    return Math.floor(likes / 100) * 100 / 1000 + 'K';
  return likes.toString();
}

// ── Milestone dedup — reads from in-memory cache ──────────────────────────────

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

// ── Log milestone to in-memory cache + sheet ──────────────────────────────────

function cacheMilestone(existingMilestones, trackName, album, platform, milestoneValue, countType, sourceUrl) {
  existingMilestones.push([
    '', trackName, album, platform, milestoneValue, countType, sourceUrl, '', ''
  ]);
}

async function persistMilestone(sheets, trackName, album, platform, milestoneValue, countType, sourceUrl) {
  await appendSheetRow(sheets, 'Milestones Achieved', [
    getPHTTimestamp(),
    trackName,
    album,
    platform,
    milestoneValue,
    countType,
    sourceUrl,
    '',
    ''
  ]);
}

// ── Build milestone Discord embed ─────────────────────────────────────────────

function buildYouTubeMilestoneEmbed(config, trackName, views, likes, countType, sourceUrl, songHashtags) {
  const closingTags    = buildClosingTags(config);
  const formattedViews = formatMilestoneNumber(views);
  const formattedLikes = formatLikesDisplay(likes);

  let sentence;
  if (countType === 'Combined Views') {
    sentence = `${config.handle}'s "${trackName}" MV has surpassed ${formattedViews} combined views and ${formattedLikes} likes on YouTube!`;
  } else if (countType === 'Likes') {
    sentence = `${config.handle}'s "${trackName}" MV has surpassed ${formattedLikes} likes on YouTube!`;
  } else {
    sentence = `${config.handle}'s "${trackName}" MV has surpassed ${formattedViews} views and ${formattedLikes} likes on YouTube!`;
  }

  const tweetLines = ['[MV MILESTONE] 🔥', '', sentence, '', `🔗 ${sourceUrl}`, ''];
  if (songHashtags) tweetLines.push(songHashtags);
  if (config.tags) tweetLines.push(config.tags);
  tweetLines.push(closingTags);

  return {
    embeds: [{
      title: '🎯 MILESTONE ALERT — Pending Approval',
      color: 16711680,
      description: tweetLines.join('\n').trim(),
      footer: { text: '✅ Approve and post manually to X | ❌ Discard' }
    }]
  };
}

// ── Send to Discord ───────────────────────────────────────────────────────────

async function sendToMilestoneWebhook(payload) {
  const webhookUrl = process.env.DISCORD_MILESTONE_WEBHOOK;
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

// ── Process milestones for a single track (normal + non-comeback tracks) ──────

async function processMilestones(sheets, existingMilestones, trackName, album, memberConfig, urls, stats, rawLogBuffer, songHashtags, isComeback) {
  const primaryUrl  = urls.primary;
  const hasCombined = stats.combined !== null;
  const viewCount   = hasCombined ? stats.combined : stats.primary.views;
  const likeCount   = stats.primary.likes;
  const countType   = hasCombined ? 'Combined Views' : 'Views';

  rawLogBuffer.push([
    getPHTTimestamp(), trackName, album, 'YouTube', countType,
    viewCount, hasCombined ? viewCount : '', primaryUrl
  ]);

  // ── View milestone ────────────────────────────────────────────────────────
  const viewInterval  = getMilestoneInterval(viewCount);
  const viewMilestone = getLastMilestone(viewCount, viewInterval);
  let viewMilestoneFired = false;

  if (!viewMilestoneFired) {
    if (!isMilestoneLogged(existingMilestones, trackName, 'YouTube', viewMilestone, countType)) {
      cacheMilestone(existingMilestones, trackName, album, 'YouTube', viewMilestone, countType, primaryUrl);
      await persistMilestone(sheets, trackName, album, 'YouTube', viewMilestone, countType, primaryUrl);
      const embed = buildYouTubeMilestoneEmbed(memberConfig, trackName, viewMilestone, likeCount, countType, primaryUrl, songHashtags);
      await sendToMilestoneWebhook(embed);
      viewMilestoneFired = true;
      console.log(`View milestone: ${trackName} | ${viewMilestone} | ${countType}`);
    }
  }

  // ── Likes milestone (100K intervals, skip if view milestone fired) ────────
  if (!viewMilestoneFired && isComeback) {
    const likeMilestone = getLastMilestone(likeCount, 100000);
    if (likeMilestone > 0) {
      if (!isMilestoneLogged(existingMilestones, trackName, 'YouTube', likeMilestone, 'Likes')) {
        cacheMilestone(existingMilestones, trackName, album, 'YouTube', likeMilestone, 'Likes', primaryUrl);
        await persistMilestone(sheets, trackName, album, 'YouTube', likeMilestone, 'Likes', primaryUrl);
        const embed = buildYouTubeMilestoneEmbed(memberConfig, trackName, viewCount, likeMilestone, 'Likes', primaryUrl, songHashtags);
        await sendToMilestoneWebhook(embed);
        console.log(`Likes milestone: ${trackName} | ${likeMilestone}`);
      }
    }
  }
}

// ── Build daily thread post ───────────────────────────────────────────────────

function buildDailyThreadPost(config, trackName, history, primaryUrl, songHashtags) {
  const MAX_CHARS   = 280;
  const closingTags = buildClosingTags(config);
  const countTypeLabel = history[0] && history[0].combined !== undefined ? 'daily combined views' : 'daily views';
  const header = `[YOUTUBE] — ${config.handle} '${trackName}' ${countTypeLabel}`;

  const dayLines = history.map((entry, i) => {
    const views = entry.views.toLocaleString();
    if (i === 0) return { base: `D${entry.day} - ${views}`, delta: '' };
    const delta    = entry.views - history[i - 1].views;
    const prevDelta = i >= 2 ? history[i - 1].views - history[i - 2].views : null;
    let emoji = '';
    if (prevDelta !== null) {
      emoji = delta > prevDelta ? ' 🔥' : ' ⚠️';
    }
    return { base: `D${entry.day} - ${views}`, delta: ` (+${delta.toLocaleString()})${emoji}` };
  });

  const footerLines = [`🔗 ${primaryUrl}`, songHashtags, config.tags, closingTags]
    .filter(Boolean)
    .join('\n');

  function assemblePost(lines) {
    return [header, '', ...lines, '', footerLines].join('\n').trim();
  }

  // Start with all deltas
  let assembled = dayLines.map(l => l.base + l.delta);
  let post = assemblePost(assembled);

  // Drop oldest deltas first until it fits
  let i = 1;
  while (post.length > MAX_CHARS && i < assembled.length) {
    assembled[i] = dayLines[i].base;
    post = assemblePost(assembled);
    i++;
  }

  return post;
}

// ── Build 24hr post ───────────────────────────────────────────────────────────

function build24hrPost(config, trackName, views, likes, primaryUrl, secondaryViews, songHashtags) {
  const closingTags    = buildClosingTags(config);
  const formattedLikes = formatLikesDisplay(likes);
  const hasCombined    = secondaryViews !== null && secondaryViews > 0;

  let sentence;
  if (hasCombined) {
    const combinedTotal     = views + secondaryViews;
    sentence = `${config.handle}'s '${trackName}' MV has surpassed ${views.toLocaleString()} views & ${formattedLikes} likes on ${config.handle}'s official YouTube channel in the first 24 hours!\nCombined: ${combinedTotal.toLocaleString()} views`;
  } else {
    sentence = `${config.handle}'s '${trackName}' MV has surpassed ${views.toLocaleString()} views and ${formattedLikes} likes on YouTube in the first 24 hours!`;
  }

  const lines = [sentence, '', `  ${primaryUrl}`];
  if (songHashtags) lines.push(songHashtags);
  if (config.tags)  lines.push(config.tags);
  lines.push(closingTags);

  return {
    embeds: [{
      title: '📊 24HR POST — Pending Approval',
      color: 16711680,
      description: lines.join('\n').trim(),
      footer: { text: '✅ Approve and post manually to X | ❌ Discard' }
    }]
  };
}

// ── Fetch comeback config ─────────────────────────────────────────────────────

async function getComebackConfig(sheets) {
  const data = await getSheetData(sheets, 'Config');
  const cfg  = {};
  for (let i = 1; i < data.length; i++) {
    if (data[i][0]) cfg[data[i][0]] = (data[i][1] || '').toString().trim();
  }
  return cfg;
}

// ── Read daily view history from Raw Scrape Log ───────────────────────────────

function getDailyHistory(rawScrapeLog, trackName) {
  const entries = [];
  for (let i = 1; i < rawScrapeLog.length; i++) {
    if (rawScrapeLog[i][1] === trackName && rawScrapeLog[i][3] === 'YouTube') {
      entries.push({
        timestamp: rawScrapeLog[i][0],
        views: rawScrapeLog[i][6]
          ? parseInt(rawScrapeLog[i][6].toString().replace(/,/g, ''), 10)
          : parseInt((rawScrapeLog[i][5] || '0').toString().replace(/,/g, ''), 10),
        combined:  rawScrapeLog[i][6] ? parseInt(rawScrapeLog[i][6].toString().replace(/,/g, ''), 10) : undefined
      });
    }
  }

  const byDay = {};
  for (const e of entries) {
    const day = new Date(e.timestamp).toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
    byDay[day] = e;
  }

  return Object.entries(byDay)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v], idx) => ({ ...v, day: idx + 1 }));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Starting YouTube scraper...');

  const sheets     = await getSheetsClient();
  const isComeback = await getComebackMode(sheets);
  console.log(`Mode: ${isComeback ? 'COMEBACK' : 'NORMAL'}`);

  const registryData      = await getSheetData(sheets, 'Master Registry');
  const existingMilestones = await getSheetData(sheets, 'Milestones Achieved');
  const rawScrapeLog      = isComeback ? await getSheetData(sheets, 'Raw Scrape Log') : [];
  const rawLogBuffer      = [];

  const trackQueue = [];

  for (let i = 1; i < registryData.length; i++) {
    const row            = registryData[i];
    const trackName      = (row[0] || '').trim();
    const album          = row[2];
    const activeTracking = (row[11] || '').toString().trim().toLowerCase();

    if (activeTracking !== 'yes') continue;

    const urlN = (row[13] || '').trim();
    const urlO = (row[14] || '').trim();

    if (!urlN) continue;

    const idN = extractVideoId(urlN);
    if (!idN) continue;

    const idO         = urlO ? extractVideoId(urlO) : null;
    const hasCombined = !!idO;

    trackQueue.push({
      row, trackName, album,
      primaryUrl: urlN, primaryId: idN,
      secondaryId: idO, hasCombined,
      memberConfig: getMemberConfig(row),
      songHashtags: (row[17] || '').trim()
    });
  }

  console.log(`Tracks to process: ${trackQueue.length}`);

  // Batch fetch all video IDs
  const allIds = [...new Set(trackQueue.flatMap(t =>
    t.hasCombined ? [t.primaryId, t.secondaryId] : [t.primaryId]
  ))];

  const statsMap = {};
  for (let i = 0; i < allIds.length; i += MAX_IDS_PER_CALL) {
    const batch = allIds.slice(i, i + MAX_IDS_PER_CALL);
    console.log(`Fetching YouTube batch ${Math.floor(i / MAX_IDS_PER_CALL) + 1}: ${batch.length} IDs`);
    const batchStats = await fetchYouTubeStats(batch);
    Object.assign(statsMap, batchStats);
    if (i + MAX_IDS_PER_CALL < allIds.length) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // ── Comeback mode ─────────────────────────────────────────────────────────
  if (isComeback) {
    const cfg           = await getComebackConfig(sheets);
    const comebackTrack = cfg['COMEBACK_TRACK'] || '';

    const nowKST  = new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul', hour: 'numeric', hour12: false });
    const kstHour = parseInt(nowKST, 10);
    const is6pmKST = kstHour >= 18 && kstHour < 20;

    for (const track of trackQueue) {
      const primaryStats   = statsMap[track.primaryId]   || { views: 0, likes: 0 };
      const secondaryStats = track.hasCombined ? (statsMap[track.secondaryId] || { views: 0, likes: 0 }) : null;
      const combinedViews = (secondaryStats && secondaryStats.views > 0 && primaryStats.views > 0) ? primaryStats.views + secondaryStats.views: null;

      const stats = { primary: primaryStats, combined: combinedViews };

      if (track.trackName !== comebackTrack) {
        await processMilestones(sheets, existingMilestones, track.trackName, track.album, track.memberConfig, { primary: track.primaryUrl }, stats, rawLogBuffer, track.songHashtags, isComeback);
        continue;
      }

      // ── Comeback track ─────────────────────────────────────────────────
      const viewCount = combinedViews !== null ? combinedViews : primaryStats.views;
      const likeCount = primaryStats.likes;
      const countType = combinedViews !== null ? 'Combined Views' : 'Views';

      rawLogBuffer.push([
        getPHTTimestamp(), track.trackName, track.album, 'YouTube', countType,
        primaryStats.views,                          // col F: primary channel only
        combinedViews !== null ? combinedViews : '', // col G: combined total
        track.primaryUrl
      ]);

      // 1M view milestones
      const milestone1M = getLastMilestone(viewCount, 1000000);
      let viewMilestoneFired = false;

      if (milestone1M > 0) {
        if (!isMilestoneLogged(existingMilestones, track.trackName, 'YouTube', milestone1M, countType)) {
          cacheMilestone(existingMilestones, track.trackName, track.album, 'YouTube', milestone1M, countType, track.primaryUrl);
          await persistMilestone(sheets, track.trackName, track.album, 'YouTube', milestone1M, countType, track.primaryUrl);
          const embed = buildYouTubeMilestoneEmbed(track.memberConfig, track.trackName, milestone1M, likeCount, countType, track.primaryUrl, track.songHashtags);
          await sendToMilestoneWebhook(embed);
          viewMilestoneFired = true;
          console.log(`Comeback 1M milestone: ${track.trackName} | ${milestone1M}`);
        }
      }

      // Likes milestone (skip if view milestone fired)
      if (viewMilestoneFired || isComeback) {
        const likeMilestone = getLastMilestone(likeCount, 100000);
        if (likeMilestone > 0) {
          if (!isMilestoneLogged(existingMilestones, track.trackName, 'YouTube', likeMilestone, 'Likes')) {
            cacheMilestone(existingMilestones, track.trackName, track.album, 'YouTube', likeMilestone, 'Likes', track.primaryUrl);
            await persistMilestone(sheets, track.trackName, track.album, 'YouTube', likeMilestone, 'Likes', track.primaryUrl);
            const embed = buildYouTubeMilestoneEmbed(track.memberConfig, track.trackName, viewCount, likeMilestone, 'Likes', track.primaryUrl, track.songHashtags);
            await sendToMilestoneWebhook(embed);
            console.log(`Likes milestone: ${track.trackName} | ${likeMilestone}`);
          }
        }
      }

     // 24hr post — fires once at 6PM KST the day AFTER release
      if (is6pmKST) {
        const releaseDate = cfg['COMEBACK_RELEASE_DATE'] || '';
        const todayKST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
        const dayAfterRelease = releaseDate
          ? new Date(new Date(releaseDate).getTime() + 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' })
          : null;
        const past24hr = dayAfterRelease && todayKST >= dayAfterRelease;
      
        if (past24hr && !isMilestoneLogged(existingMilestones, track.trackName, 'YouTube', 0, '24hr')) {
          cacheMilestone(existingMilestones, track.trackName, track.album, 'YouTube', 0, '24hr', track.primaryUrl);
          await persistMilestone(sheets, track.trackName, track.album, 'YouTube', 0, '24hr', track.primaryUrl);
          const embed = build24hrPost(
            track.memberConfig, track.trackName,
            primaryStats.views, likeCount, track.primaryUrl,
            secondaryStats ? secondaryStats.views : null,
            track.songHashtags
          );
          await sendToMilestoneWebhook(embed);
          console.log(`24hr post fired: ${track.trackName}`);
        }
      }

     // Daily thread post — fires at 6PM KST every day
      if (is6pmKST) {
        const history = getDailyHistory(rawScrapeLog, track.trackName);
        // Append today's live count as current day entry (not yet in log)
        const todayEntry = {
          views: combinedViews !== null ? combinedViews : primaryStats.views,
          day: history.length + 1,
          combined: combinedViews !== null ? combinedViews : undefined
        };
        const fullHistory = [...history, todayEntry];
      
        if (fullHistory.length > 0) {
          const post = buildDailyThreadPost(
            track.memberConfig, track.trackName, fullHistory,
            track.primaryUrl, track.songHashtags
          );
          await sendToMilestoneWebhook({
            embeds: [{
              title: '📈 DAILY THREAD POST — Pending Approval',
              color: 16711680,
              description: post,
              footer: { text: '✅ Post as reply to previous day | ❌ Discard' }
            }]
          });
        }
      }
    }

  // ── Normal mode ───────────────────────────────────────────────────────────
  } else {
    for (const track of trackQueue) {
      const primaryStats   = statsMap[track.primaryId]   || { views: 0, likes: 0 };
      const secondaryStats = track.hasCombined ? (statsMap[track.secondaryId] || { views: 0, likes: 0 }) : null;
      const combinedViews  = secondaryStats ? primaryStats.views + secondaryStats.views : null;

      const stats = { primary: primaryStats, combined: combinedViews };

      await processMilestones(sheets, existingMilestones, track.trackName, track.album, track.memberConfig, 
        { primary: track.primaryUrl }, stats, rawLogBuffer, track.songHashtags, isComeback);
    }
  }

  console.log(`Writing ${rawLogBuffer.length} rows to Raw Scrape Log...`);
  await batchAppendRows(sheets, 'Raw Scrape Log', rawLogBuffer, 'A:H');

  console.log('YouTube scraper complete.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
