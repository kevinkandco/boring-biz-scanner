const { google } = require("googleapis");

const HEADERS = [
  "Fit Score",
  "Name",
  "Category",
  "Region",
  "Address",
  "Rating",
  "Reviews",
  "Website",
  "Phone",
  "Sell Signals",
  "Upside Signals",
  "Est. Value",
  "Outreach Angle",
  "Notes",
  "Maps URL",
  "Place ID",
  "Scanned At",
  "Advisor Take",
];

const PLACE_ID_COL = HEADERS.indexOf("Place ID");
const LAST_COL = "R"; // 18 columns: A..R

async function writeTargetsToSheet(auth, targets) {
  const sheets = google.sheets({ version: "v4", auth });
  const spreadsheetId = process.env.SPREADSHEET_ID;
  const sheetName = "Targets";

  // ensure sheet exists
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
  let sheet = spreadsheet.data.sheets.find(
    (s) => s.properties.title === sheetName
  );
  if (!sheet) {
    const created = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: sheetName } } }],
      },
    });
    sheet = { properties: created.data.replies[0].addSheet.properties };
  }

  // read existing place IDs to avoid duplicates
  const existingIds = new Set();
  try {
    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${sheetName}'!A:${LAST_COL}`,
    });
    if (existing.data.values && existing.data.values.length > 1) {
      for (const row of existing.data.values.slice(1)) {
        if (row[PLACE_ID_COL]) existingIds.add(row[PLACE_ID_COL]);
      }
    }
  } catch {
    // sheet might be empty
  }

  const newTargets = targets.filter((t) => !existingIds.has(t.placeId));

  if (newTargets.length === 0) {
    console.log("  No new targets to add (all already tracked).");
    return { added: 0, duplicates: targets.length, newTargets: [] };
  }

  // check if headers exist
  let hasHeaders = false;
  try {
    const headerCheck = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${sheetName}'!A1:${LAST_COL}1`,
    });
    hasHeaders = headerCheck.data.values && headerCheck.data.values.length > 0;
  } catch {
    // no headers yet
  }

  const rows = [];
  if (!hasHeaders) rows.push(HEADERS);

  for (const t of newTargets) {
    rows.push([
      t.fit_score ?? 0,
      t.name || "",
      t.category || "",
      t.region || "",
      t.address || "",
      t.rating ?? "",
      t.reviewCount ?? "",
      t.website || "",
      t.phone || "",
      Array.isArray(t.sell_signals) ? t.sell_signals.join("; ") : "",
      Array.isArray(t.upside_signals) ? t.upside_signals.join("; ") : "",
      t.est_value_range || "",
      t.outreach_angle || "",
      t.notes || "",
      t.mapsUrl || "",
      t.placeId || "",
      t.scoredAt || "",
      t.advisor_take || "",
    ]);
  }

  const range = hasHeaders ? `'${sheetName}'!A2` : `'${sheetName}'!A1`;

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: rows },
  });

  // format header row if we just created it
  if (!hasHeaders) {
    const sheetId = sheet.properties.sheetId;
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            repeatCell: {
              range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
              cell: {
                userEnteredFormat: {
                  backgroundColor: { red: 0.15, green: 0.15, blue: 0.15 },
                  textFormat: {
                    bold: true,
                    foregroundColor: { red: 1, green: 1, blue: 1 },
                  },
                },
              },
              fields: "userEnteredFormat(textFormat,backgroundColor)",
            },
          },
          {
            updateSheetProperties: {
              properties: {
                sheetId,
                gridProperties: { frozenRowCount: 1 },
              },
              fields: "gridProperties.frozenRowCount",
            },
          },
          {
            autoResizeDimensions: {
              dimensions: {
                sheetId,
                dimension: "COLUMNS",
                startIndex: 0,
                endIndex: HEADERS.length,
              },
            },
          },
        ],
      },
    });
  }

  console.log(
    `  Added ${newTargets.length} new targets (${targets.length - newTargets.length} already tracked)`
  );
  return {
    added: newTargets.length,
    duplicates: targets.length - newTargets.length,
    newTargets,
  };
}

module.exports = { writeTargetsToSheet };
