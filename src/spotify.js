//----- check comeback mode at runtime and adjust its behavior -------------------
async function main() {
  console.log('Starting Spotify scraper...');
  const sheets = await getSheetsClient();
  const isComeback = await getComebackMode(sheets);
  console.log(`Mode: ${isComeback ? 'COMEBACK' : 'NORMAL'}`);

  // In normal mode only run on Saturdays (day 6)
  if (!isComeback) {
    const dayOfWeek = new Date().toLocaleString('en-US', {
      timeZone: 'Asia/Manila',
      weekday: 'long'
    });
    if (dayOfWeek !== 'Saturday') {
      console.log('Normal mode — skipping non-Saturday run.');
      return;
    }
  }

//----- Rest of scraping logic -------------------

const {
  getSheetsClient,
  getSheetData,
  batchAppendRows,
  getMemberConfig,
  checkMilestone,
  sendDiscordDraft,
  logToSheet,
  findMatchInRegistry
} = require('./helpers');

const fetch = require('node-fetch');

const ARTIST_PAGES = [
  { url: 'https://kworb.net/spotify/artist/0XATRDCYuuGhk0oE7C0o5G_songs.html', label: 'MAMAMOO' },
  { url: 'https://kworb.net/spotify/artist/5cYcI546S8Lf97m4mNdYLD_songs.html', label: 'Solar' },
  { url: 'https://kworb.net/spotify/artist/1eTft3tXynrKdo6XD7QHLL.html',        label: 'Moonbyul' },
  { url: 'https://kworb.net/spotify/artist/0BqRGrwqndrtNkojXiqIzL_songs.html', label: 'Wheein' },
  { url: 'https://kworb.net/spotify/artist/7bmYpVgQub656uNTu6qGNQ_songs.html', label: 'Hwasa' }
];

function parseKworbTable(html) {
  const tracks = [];
  const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];

  for (const row of rows) {
    const cells = [];
    const cellPattern = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch;
    while ((cellMatch = cellPattern.exec(row)) !== null) {
      const cellText = cellMatch[1].replace(/<[^>]+>/g, '').trim();
      cells.push(cellText);
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

    if (!title || streams < 1000) continue;
    tracks.push({ title, streams, daily });
  }

  return tracks;
}

async function scrapeSpotifyPage(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  return response.text();
}

async function main() {
  console.log('Starting Spotify scraper...');

  const sheets       = await getSheetsClient();
  const registryData = await getSheetData(sheets, 'Master Registry');

  const milestones     = [];
  const rawLogBuffer   = [];
  const unmatchedBuffer = [];
  const processedTracks = new Set();

  for (const artist of ARTIST_PAGES) {
    console.log(`Scraping: ${artist.label}`);

    let html;
    try {
      html = await scrapeSpotifyPage(artist.url);
    } catch(e) {
      console.error(`Fetch error for ${artist.label}: ${e.message}`);
      continue;
    }

    const tracks = parseKworbTable(html);
    console.log(`  Found ${tracks.length} tracks for ${artist.label}`);

    for (const track of tracks) {
      const match = findMatchInRegistry(track.title, registryData);

      if (!match) {
        unmatchedBuffer.push([
          new Date().toISOString(),
          track.title,
          track.streams,
          track.daily,
          artist.label
        ]);
        continue;
      }

      const matchedRow     = match.row;
      const trackName      = matchedRow[0];
      const album          = matchedRow[2];
      const activeTracking = matchedRow[15]; // Column P - Effective Tracking

      if (activeTracking.toString().trim().toLowerCase() !== 'yes') continue;

      const trackKey = `${trackName}|Spotify`;
      if (processedTracks.has(trackKey)) continue;
      processedTracks.add(trackKey);

      const memberConfig = getMemberConfig(matchedRow);
      const spotifyUri = matchedRow[10]; // Column K
      const spotifyUrl = spotifyUri 
        ? 'https://open.spotify.com/track/' + spotifyUri.replace('spotify:track:', '')
        : `https://open.spotify.com/search/${encodeURIComponent(trackName)}`;

      // Buffer raw log entry
      rawLogBuffer.push([
        new Date().toISOString(),
        trackName,
        album,
        'Spotify',
        'Streams',
        track.streams,
        '',
        artist.url
      ]);

      // Check milestone
      const milestone = await checkMilestone(
        sheets,
        trackName,
        album,
        'Spotify',
        'Streams',
        track.streams,
        spotifyUrl,
        memberConfig
      );

      if (milestone) milestones.push(milestone);
    }

    // Polite delay between pages
    await new Promise(r => setTimeout(r, 2000));
  }

  // Batch write to sheets
  console.log(`Writing ${rawLogBuffer.length} rows to Raw Scrape Log...`);
  await batchAppendRows(sheets, 'Raw Scrape Log', rawLogBuffer);

  if (unmatchedBuffer.length > 0) {
    console.log(`Writing ${unmatchedBuffer.length} unmatched rows...`);
    await batchAppendRows(sheets, 'Unmatched Tracks', unmatchedBuffer);
  }

  // Send Discord notifications
  console.log(`Milestones found: ${milestones.length}`);
  await sendDiscordDraft(milestones);

  console.log('Spotify scraper complete.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
