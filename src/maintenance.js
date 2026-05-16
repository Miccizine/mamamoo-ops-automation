const { getSheetsClient, getSheetData, getPHTTimestamp } = require('./helpers');

const GRAY_BACKGROUND = { red: 0.851, green: 0.851, blue: 0.851 };
const GRAY_TEXT       = { red: 0.4,   green: 0.4,   blue: 0.4 };

async function processMilestonesSheet(sheets) {
  const sheetId  = process.env.GOOGLE_SHEETS_ID;
  const data     = await getSheetData(sheets, 'Milestones Achieved');
  const requests = [];

  // Get the actual sheet ID (gid) for Milestones Achieved
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const milestonesSheet = spreadsheet.data.sheets.find(
    s => s.properties.title === 'Milestones Achieved'
  );
  if (!milestonesSheet) {
    console.log('Milestones Achieved sheet not found');
    return;
  }
  const gid = milestonesSheet.properties.sheetId;

  for (let i = 1; i < data.length; i++) {
    const row         = data[i];
    const rowIndex    = i; // 0-based for API
    const hasDate     = row[0] && row[0] !== '';
    const hasCheckbox = row[7] !== '' && row[7] !== undefined;
    const isPublished = (row[7] === true || row[7] === 'TRUE') && (row[8] && row[8] !== '');
    const hasGrayBg   = row[8] && row[8] !== '';

    // Add checkbox if row has data but no checkbox yet
    if (hasDate && !hasCheckbox) {
      requests.push({
        repeatCell: {
          range: {
            sheetId:          gid,
            startRowIndex:    rowIndex,
            endRowIndex:      rowIndex + 1,
            startColumnIndex: 7, // Column H
            endColumnIndex:   8
          },
          cell: {
            dataValidation: {
              condition: { type: 'BOOLEAN' },
              showCustomUi: true
            }
          },
          fields: 'dataValidation'
        }
      });
      console.log(`Added checkbox to row ${i + 1}: ${row[1]}`);
    }

    // Gray out row if published and not already grayed
    if (isPublished && !hasGrayBg) {
      // Write published date to column I
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range:         `Milestones Achieved!I${i + 1}`,
        valueInputOption: 'USER_ENTERED',
        resource: { values: [[getPHTTimestamp()]] }
      });

      // Gray out the row
      requests.push({
        repeatCell: {
          range: {
            sheetId:          gid,
            startRowIndex:    rowIndex,
            endRowIndex:      rowIndex + 1,
            startColumnIndex: 0,
            endColumnIndex:   9
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: GRAY_BACKGROUND,
              textFormat: { foregroundColor: GRAY_TEXT }
            }
          },
          fields: 'userEnteredFormat(backgroundColor,textFormat)'
        }
      });
      console.log(`Grayed out published row ${i + 1}: ${row[1]}`);
    }
  }

  if (requests.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      resource: { requests }
    });
    console.log(`Applied ${requests.length} formatting updates`);
  } else {
    console.log('No formatting updates needed');
  }
}

async function main() {
  console.log('Starting sheet maintenance...');
  const sheets = await getSheetsClient();
  await processMilestonesSheet(sheets);
  console.log('Sheet maintenance complete.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
