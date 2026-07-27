// Keeps the spreadsheet clean and consistent:
//  - migrates legacy-schema rows (pre-July-2026 20-column layout) to the current layout
//  - archives stale listings to an Archive tab
//  - keeps tabs sorted (best first)
// Idempotent — safe to run after every scan.

const { google } = require("googleapis");

const DEAL_HEADERS = [
  "Score", "Go/No-Go", "Title", "Type", "Asking Price", "SDE", "Cash Flow",
  "Revenue", "Location", "Absentee", "Hands-Off", "Optimization", "Durability",
  "SDE Multiple", "Valuation", "SBA Down Payment", "Monthly Payment", "DSCR",
  "SBA Feasible", "Optimizations", "Absentee Realistic", "Manager Cost",
  "Deal Summary", "Red Flags", "Source", "URL", "Email Date", "Scored At",
  "Signals", "Advisor Take", "Next Action", "Broker Questions", "Walk-Away Price",
];

const TARGET_HEADERS = [
  "Fit Score", "Name", "Category", "Region", "Address", "Rating", "Reviews",
  "Website", "Phone", "Sell Signals", "Upside Signals", "Est. Value",
  "Outreach Angle", "Notes", "Maps URL", "Place ID", "Scanned At",
  "Advisor Take",
];

// archive listings when: score < 6 and older than ARCHIVE_AFTER_DAYS,
// or older than STALE_AFTER_DAYS regardless of score (listing likely gone)
const ARCHIVE_AFTER_DAYS = parseInt(process.env.ARCHIVE_AFTER_DAYS || "30", 10);
const STALE_AFTER_DAYS = parseInt(process.env.STALE_AFTER_DAYS || "90", 10);

// Legacy 20-col layout (pre-deep-analysis schema) → current 28-col positions.
// Old cols 12 (Meets SDE Min) and 13 (Driving Distance) have no new home and are dropped;
// old Deal Notes (14) maps to Deal Summary.
function migrateLegacyDealRow(row) {
  const out = new Array(DEAL_HEADERS.length).fill("");
  out[0] = row[0] || "";   // Score
  out[2] = row[1] || "";   // Title
  out[3] = row[2] || "";   // Type
  out[4] = row[3] || "";   // Asking Price
  out[5] = row[4] || "";   // SDE
  out[6] = row[5] || "";   // Cash Flow
  out[7] = row[6] || "";   // Revenue
  out[8] = row[7] || "";   // Location
  out[9] = row[8] || "";   // Absentee
  out[10] = row[9] || "";  // Hands-Off
  out[11] = row[10] || ""; // Optimization
  out[12] = row[11] || ""; // Durability
  out[22] = row[14] || ""; // Deal Notes -> Deal Summary
  out[23] = row[15] || ""; // Red Flags
  out[24] = row[16] || ""; // Source
  out[25] = row[17] || ""; // URL
  out[26] = row[18] || ""; // Email Date
  out[27] = row[19] || ""; // Scored At
  return out;
}

function isLegacyDealRow(row) {
  // current-schema rows carry 28 columns; legacy rows carry at most 20
  return row.length <= 20;
}

function ageInDays(dateStr) {
  const t = Date.parse(dateStr);
  if (Number.isNaN(t)) return null;
  return (Date.now() - t) / (1000 * 60 * 60 * 24);
}

async function getSheetId(sheets, spreadsheetId, title) {
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
  let sheet = spreadsheet.data.sheets.find((s) => s.properties.title === title);
  if (!sheet) {
    const created = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title } } }] },
    });
    return created.data.replies[0].addSheet.properties.sheetId;
  }
  return sheet.properties.sheetId;
}

async function rewriteTab(sheets, spreadsheetId, tabName, headers, rows) {
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: `'${tabName}'`,
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${tabName}'!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [headers, ...rows] },
  });
  const sheetId = await getSheetId(sheets, spreadsheetId, tabName);
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
                textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
              },
            },
            fields: "userEnteredFormat(textFormat,backgroundColor)",
          },
        },
        {
          updateSheetProperties: {
            properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
            fields: "gridProperties.frozenRowCount",
          },
        },
      ],
    },
  });
}

async function appendToArchive(sheets, spreadsheetId, tabName, headers, rows) {
  if (rows.length === 0) return;
  await getSheetId(sheets, spreadsheetId, tabName); // ensure exists
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${tabName}'!A1:A1`,
  }).catch(() => null);
  const hasHeader = existing?.data?.values?.length > 0;
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `'${tabName}'!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: hasHeader ? rows : [headers, ...rows] },
  });
}

async function cleanDealFlow(auth) {
  const sheets = google.sheets({ version: "v4", auth });
  const spreadsheetId = process.env.SPREADSHEET_ID;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "'Deal Flow'!A:AG",
  }).catch(() => null);
  const rows = res?.data?.values || [];
  if (rows.length < 2) return { migrated: 0, archived: 0, kept: 0 };

  // migrate any legacy-layout rows to the current schema
  let migrated = 0;
  const dataRows = rows.slice(1).map((r) => {
    if (isLegacyDealRow(r)) {
      migrated++;
      return migrateLegacyDealRow(r);
    }
    // pad short rows so column positions are stable
    while (r.length < DEAL_HEADERS.length) r.push("");
    return r;
  });

  // split into keep vs archive
  const EMAIL_DATE = DEAL_HEADERS.indexOf("Email Date");
  const keep = [];
  const archive = [];
  for (const r of dataRows) {
    const score = parseInt(r[0], 10) || 0;
    const age = ageInDays(r[EMAIL_DATE]);
    const isStale = age != null && age > STALE_AFTER_DAYS;
    const isOldAndWeak = age != null && age > ARCHIVE_AFTER_DAYS && score < 6;
    if (isStale || isOldAndWeak) archive.push(r);
    else keep.push(r);
  }

  // best deals first, newest first within a score
  keep.sort((a, b) => {
    const scoreDiff = (parseInt(b[0], 10) || 0) - (parseInt(a[0], 10) || 0);
    if (scoreDiff !== 0) return scoreDiff;
    return (Date.parse(b[EMAIL_DATE]) || 0) - (Date.parse(a[EMAIL_DATE]) || 0);
  });

  await appendToArchive(sheets, spreadsheetId, "Archive", DEAL_HEADERS, archive);
  await rewriteTab(sheets, spreadsheetId, "Deal Flow", DEAL_HEADERS, keep);

  return { migrated, archived: archive.length, kept: keep.length };
}

async function cleanTargets(auth) {
  const sheets = google.sheets({ version: "v4", auth });
  const spreadsheetId = process.env.SPREADSHEET_ID;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "'Targets'!A:R",
  }).catch(() => null);
  const rows = res?.data?.values || [];
  if (rows.length < 2) return { archived: 0, kept: 0 };

  const dataRows = rows.slice(1).map((r) => {
    while (r.length < TARGET_HEADERS.length) r.push("");
    return r;
  });

  // weak targets (franchises, too small) go to archive; rest sorted best-first
  const keep = [];
  const archive = [];
  for (const r of dataRows) {
    const fit = parseInt(r[0], 10) || 0;
    if (fit <= 4) archive.push(r);
    else keep.push(r);
  }
  keep.sort((a, b) => (parseInt(b[0], 10) || 0) - (parseInt(a[0], 10) || 0));

  await appendToArchive(sheets, spreadsheetId, "Targets Archive", TARGET_HEADERS, archive);
  await rewriteTab(sheets, spreadsheetId, "Targets", TARGET_HEADERS, keep);

  return { archived: archive.length, kept: keep.length };
}

module.exports = { cleanDealFlow, cleanTargets };
