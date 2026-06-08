'use strict';

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

async function searchItunesApi(trackName, artistName, retries = 2) {
  const query = encodeURIComponent(`${trackName} ${artistName}`);
  const url = `https://itunes.apple.com/search?term=${query}&entity=song&limit=10&media=music&country=ph`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });

      if (response.status === 429 || response.status === 403) {
        if (attempt < retries) {
          const wait = (attempt + 1) * 3000;
          console.log(`HTTP ${response.status} for "${trackName}" — retrying in ${wait/1000}s...`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        console.error(`iTunes API error for "${trackName}": HTTP ${response.status}`);
        return [];
      }

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      return data.results || [];

    } catch(e) {
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      console.error(`iTunes API error for "${trackName}": ${e.message}`);
      return [];
    }
  }
  return [];
}

// ── Confidence Scoring ────────────────────────────────────────────────────────

function scoreResult(result, registryTrack, registryArtist, registryAlbum, registryYear) {
  let score = 0;

  const normalResult   = normalizeTitle(result.trackName || '');
  const normalTrack    = normalizeTitle(registryTrack);
  const normalArtist   = (result.artistName || '').toLowerCase();
  const normalAlbum    = normalizeTitle(result.collectionName || '');
  const normalRegAlbum = normalizeTitle(registryAlbum || '');
  const resultYear     = result.releaseDate
    ? new Date(result.releaseDate).getFullYear().toString()
    : '';

  if (normalResult === normalTrack) {
    score += 3;
  } else if (normalResult.includes(normalTrack) || normalTrack.includes(normalResult)) {
    score += 1;
  }

  const isMamamooArtist = MAMAMOO_ARTISTS.some(a => normalArtist.includes(a));
  if (isMamamooArtist) score += 2;

  const registryArtistLower = (registryArtist || '').toLowerCase();
  const artistParts = registryArtistLower.split(';').map(a => a.trim());
  const resultArtistMatches = artistParts.some(part =>
    normalArtist.includes(part) || part.includes(normalArtist)
  );
  if (resultArtistMatches) score += 1;

  if (normalRegAlbum && normalAlbum === normalRegAlbum) score += 1;
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

  const alreadyReviewed = new Set();
  for (let i = 1; i < reviewData.length; i++) {
    if (reviewData[i][1]) alreadyReviewed.add(reviewData[i][1]);
  }

  const reviewBuffer   = [];
  const updateRequests = [];
  let filled  = 0;
  let flagged = 0;
  let skipped = 0;

  for (let i = 1; i < registryData.length; i++) {
    const row         = registryData[i];
    const trackName   = row[0] ? row[0].toString().trim() : '';
    const artist      = row[1] ? row[1].toString().trim() : '';
    const album       = row[2] ? row[2].toString().trim() : '';
    const releaseDate = row[3] ? row[3].toString().trim() : '';
    const appleUrl    = row[13] ? row[13].toString().trim() : ''; // col N (index 13)

    if (!trackName) continue;

    if (appleUrl) {
      skipped++;
      continue;
    }

    const releaseYear   = releaseDate
      ? new Date(releaseDate).getFullYear().toString()
      : '';
    const primaryArtist = artist.split(';')[0].trim();
    const results       = await searchItunesApi(trackName, primaryArtist);

    if (results.length === 0) {
      console.log(`No results: ${trackName}`);
      continue;
    }

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
      // Write to col N (index 13, sheet column N)
      updateRequests.push({ rowIndex: i + 1, url: best.url });
      filled++;
      console.log(`✅ ${trackName} → ${best.url.substring(0, 60)}...`);
    } else if (best.score >= 2 && !alreadyReviewed.has(trackName)) {
      reviewBuffer.push([
        getPHTTimestamp(), trackName, artist, album,
        best.url, best.score, 'Pending'
      ]);
      flagged++;
      console.log(`⚠️  ${trackName} (score ${best.score}) → flagged for review`);
    }

    await new Promise(r => setTimeout(r, 1500));
  }

  if (updateRequests.length > 0) {
    console.log(`Writing ${updateRequests.length} Apple Music URLs to registry...`);
    const batchData = updateRequests.map(req => ({
      range:  `Master Registry!N${req.rowIndex}`, // col N
      values: [[req.url]]
    }));
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetId,
      resource: {
        valueInputOption: 'USER_ENTERED',
        data: batchData
      }
    });
  }

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
