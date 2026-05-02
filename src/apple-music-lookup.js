const {
  getSheetsClient,
  getSheetData,
  getPHTTimestamp,
  normalizeTitle
} = require('./helpers');

const fetch = require('node-fetch');

const MAMAMOO_ARTISTS = [
  'mamamoo', 'solar', 'moon byul', 'moonbyul', 'wheein', 'whee in',
  'hwasa', 'mamamoo+'
];

// ── iTunes Search API ─────────────────────────────────────────────────────────

async function searchItunesApi(trackName, artistName) {
  const query = encodeURIComponent(`${trackName} ${artistName}`);
  const url   = `https://itunes.apple.com/search?term=${query}&entity=song&limit=10&media=music`;

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return data.results || [];
  } catch(e) {
    console.error(`iTunes API error for "${trackName}": ${e.message}`);
    return [];
  }
}

// ── Confidence Scoring ────────────────────────────────────────────────────────

function scoreResult(result, registryTrack, registryArtist, registryAlbum, registryYear) {
  let score = 0;

  const normalResult  = normalizeTitle(result.trackName || '');
  const normalTrack   = normalizeTitle(registryTrack);
  const normalArtist  = (result.artistName || '').toLowerCase();
  const normalAlbum   = normalizeTitle(result.collectionName || '');
  const normalRegAlbum = normalizeTitle(registryAlbum || '');
  const resultYear    = result.releaseDate
    ? new Date(result.releaseDate).getFullYear().toString()
    : '';

  // Track name matching
  if (normalResult === normalTrack) {
    score += 3;
  } else if (normalResult.includes(normalTrack) || normalTrack.includes(normalResult)) {
    score += 1;
  }

  // Artist matching — check if result artist contains any Mamamoo-related name
  const isMamamooArtist = MAMAMOO_ARTISTS.some(a => normalArtist.includes(a));
  if (isMamamooArtist) score += 2;

  // Also check if registry artist matches result artist
  const registryArtistLower = (registryArtist || '').toLowerCase();
  const artistParts = registryArtistLower.split(';').map(a => a.trim());
  const resultArtistMatches = artistParts.some(part =>
    normalArtist.includes(part) || part.includes(normalArtist)
  );
  if (resultArtistMatches) score += 1;

  // Album matching
  if (normalRegAlbum && normalAlbum === normalRegAlbum) score += 1;

  // Release year matching
  if (registryYear && resultYear === registryYear) score += 1;

  return score;
}

// ── Main Lookup Logic ─────────────────────────────────────────────────────────

async function main() {
  console.log('Starting Apple Music URL lookup...');

  const sheets       = await getSheetsClient();
  const registryData = await getSheetData(sheets, 'Master Registry');
  const reviewData   = await getSheetData(sheets, 'Apple Music Review');
  const sheetId      = process.env.GOOGLE_SHEETS_ID;

  // Build set of tracks already in review sheet to avoid duplicates
  const alreadyReviewed = new Set();
  for (let i = 1; i < reviewData.length; i++) {
    if (reviewData[i][1]) alreadyReviewed.add(reviewData[i][1]);
  }

  const reviewBuffer  = [];
  const updateRequests = [];
  let filled  = 0;
  let flagged = 0;
  let skipped = 0;

  for (let i = 1; i < registryData.length; i++) {
    const row          = registryData[i];
    const trackName    = row[0] ? row[0].toString().trim() : '';
    const artist       = row[1] ? row[1].toString().trim() : '';
    const album        = row[2] ? row[2].toString().trim() : '';
    const releaseDate  = row[3] ? row[3].toString().trim() : '';
    const appleUrl     = row[16] ? row[16].toString().trim() : '';

    if (!trackName) continue;

    // Skip if Apple Music URL already populated
    if (appleUrl) {
      skipped++;
      continue;
    }

    const releaseYear = releaseDate
      ? new Date(releaseDate).getFullYear().toString()
      : '';

    // Extract primary artist from semicolon-separated list
    const primaryArtist = artist.split(';')[0].trim();

    const results = await searchItunesApi(trackName, primaryArtist);

    if (results.length === 0) {
      console.log(`No results: ${trackName}`);
      continue;
    }

    // Score all results
    const scored = results
      .map(r => ({
        result: r,
        score:  scoreResult(r, trackName, artist, album, releaseYear),
        url:    r.trackViewUrl || ''
      }))
      .filter(s => s.score >= 2)
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) {
      console.log(`No confident match: ${trackName}`);
      continue;
    }

    const best = scored[0];

    if (best.score >= 4) {
      // High confidence — write directly to registry column Q (index 16, row i+1)
      updateRequests.push({
        rowIndex: i + 1, // 1-based
        url:      best.url
      });
      filled++;
      console.log(`✅ ${trackName} → ${best.url.substring(0, 60)}...`);
    } else if (best.score >= 2 && !alreadyReviewed.has(trackName)) {
      // Low confidence — flag for manual review
      reviewBuffer.push([
        getPHTTimestamp(),
        trackName,
        artist,
        album,
        best.url,
        best.score,
        'Pending'
      ]);
      flagged++;
      console.log(`⚠️  ${trackName} (score ${best.score}) → flagged for review`);
    }

    // Polite delay to avoid rate limiting iTunes API
    await new Promise(r => setTimeout(r, 1000));
  }

  // Batch write high-confidence URLs to registry
  if (updateRequests.length > 0) {
    console.log(`Writing ${updateRequests.length} Apple Music URLs to registry...`);

    for (const req of updateRequests) {
      await sheets.spreadsheets.values.update({
        spreadsheetId:    sheetId,
        range:            `Master Registry!Q${req.rowIndex}`,
        valueInputOption: 'USER_ENTERED',
        resource:         { values: [[req.url]] }
      });
    }
  }

  // Batch write flagged matches to review sheet
  if (reviewBuffer.length > 0) {
    console.log(`Writing ${reviewBuffer.length} flagged matches to Apple Music Review...`);
    await sheets.spreadsheets.values.append({
      spreadsheetId:    sheetId,
      range:            'Apple Music Review!A:G',
      valueInputOption: 'USER_ENTERED',
      resource:         { values: reviewBuffer }
    });
  }

  console.log(`\nSummary:`);
  console.log(`  Filled automatically: ${filled}`);
  console.log(`  Flagged for review:   ${flagged}`);
  console.log(`  Already had URL:      ${skipped}`);
  console.log('Apple Music lookup complete.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
