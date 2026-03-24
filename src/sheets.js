const { google } = require("googleapis");

const HEADERS = [
  "Score",
  "Title",
  "Type",
  "Asking Price",
  "SDE",
  "Cash Flow",
  "Revenue",
  "Location",
  "Absentee",
  "Hands-Off",
  "Optimization",
  "Durability",
  "Meets SDE Min",
  "Driving Distance",
  "Deal Notes",
  "Red Flags",
  "Source",
  "URL",
  "Email Date",
  "Scored At",
];

async function writeToSheet(auth, scoredListings) {
  const sheets = google.sheets({ version: "v4", auth });
  const spreadsheetId = process.env.SPREADSHEET_ID;
  const sheetName = "Deal Flow";

  // ensure sheet exists
  try {
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
    const existing = spreadsheet.data.sheets.find(
      (s) => s.properties.title === sheetName
    );
    if (!existing) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{ addSheet: { properties: { title: sheetName } } }],
        },
      });
    }
  } catch (err) {
    console.error(`  Error checking sheet: ${err.message}`);
    throw err;
  }

  // read existing URLs to avoid duplicates
  let existingUrls = new Set();
  let existingTitles = new Set();
  try {
    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${sheetName}'!A:T`,
    });
    if (existing.data.values && existing.data.values.length > 1) {
      for (const row of existing.data.values.slice(1)) {
        if (row[17]) existingUrls.add(row[17]); // URL column
        if (row[1]) existingTitles.add(row[1].toLowerCase()); // Title column
      }
    }
  } catch {
    // sheet might be empty
  }

  // filter out duplicates
  const newListings = scoredListings.filter((l) => {
    if (l.url && existingUrls.has(l.url)) return false;
    if (l.title && existingTitles.has(l.title.toLowerCase())) return false;
    return true;
  });

  if (newListings.length === 0) {
    console.log("  No new listings to add (all duplicates).");
    return { added: 0, duplicates: scoredListings.length };
  }

  // check if headers exist
  let hasHeaders = false;
  try {
    const headerCheck = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${sheetName}'!A1:T1`,
    });
    hasHeaders =
      headerCheck.data.values && headerCheck.data.values.length > 0;
  } catch {
    // no headers yet
  }

  const rows = [];

  if (!hasHeaders) {
    rows.push(HEADERS);
  }

  for (const l of newListings) {
    rows.push([
      l.overall_score || 0,
      l.title || "",
      l.business_type || "",
      l.asking_price ? `$${l.asking_price.toLocaleString()}` : "",
      l.sde ? `$${l.sde.toLocaleString()}` : "",
      l.cash_flow ? `$${l.cash_flow.toLocaleString()}` : "",
      l.revenue ? `$${l.revenue.toLocaleString()}` : "",
      l.location || "",
      l.absentee_score || "",
      l.handsoff_score || "",
      l.optimization_score || "",
      l.durability_score || "",
      l.meets_sde_minimum === true
        ? "Yes"
        : l.meets_sde_minimum === false
          ? "No"
          : "Unknown",
      l.within_driving_distance === true
        ? "Yes"
        : l.within_driving_distance === false
          ? "No"
          : "Unknown",
      l.deal_notes || "",
      Array.isArray(l.red_flags) ? l.red_flags.join("; ") : "",
      l.source || "",
      l.url || "",
      l.emailDate || "",
      l.scoredAt || "",
    ]);
  }

  // append rows
  const range = hasHeaders ? `'${sheetName}'!A2` : `'${sheetName}'!A1`;

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: rows },
  });

  // apply formatting to header row if we just created it
  if (!hasHeaders) {
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
    const sheet = spreadsheet.data.sheets.find(
      (s) => s.properties.title === sheetName
    );
    const sheetId = sheet.properties.sheetId;

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          // bold header row
          {
            repeatCell: {
              range: {
                sheetId,
                startRowIndex: 0,
                endRowIndex: 1,
              },
              cell: {
                userEnteredFormat: {
                  textFormat: { bold: true },
                  backgroundColor: { red: 0.15, green: 0.15, blue: 0.15 },
                  textFormat: {
                    bold: true,
                    foregroundColor: { red: 1, green: 1, blue: 1 },
                  },
                },
              },
              fields:
                "userEnteredFormat(textFormat,backgroundColor)",
            },
          },
          // freeze header row
          {
            updateSheetProperties: {
              properties: {
                sheetId,
                gridProperties: { frozenRowCount: 1 },
              },
              fields: "gridProperties.frozenRowCount",
            },
          },
          // auto-resize columns
          {
            autoResizeDimensions: {
              dimensions: {
                sheetId,
                dimension: "COLUMNS",
                startIndex: 0,
                endIndex: 20,
              },
            },
          },
        ],
      },
    });
  }

  console.log(
    `  Added ${newListings.length} new listings (${scoredListings.length - newListings.length} duplicates skipped)`
  );
  return {
    added: newListings.length,
    duplicates: scoredListings.length - newListings.length,
  };
}

module.exports = { writeToSheet };
