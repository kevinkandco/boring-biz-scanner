// Run-health recording: every scan (success or failure) writes
// data/last-run.json and appends a row to the "Health" tab of the sheet —
// a visible heartbeat. If the tab stops updating, the schedule is dead.
//
// Failure alerting: tries to email via the Gmail API. The OAuth token was
// issued with gmail.readonly only, so sending fails with 403 unless
// setup-oauth.js is re-run with the gmail.send scope added — the code path
// exists either way, and the fallback is a prominent FAILED row in Health.

const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

const DATA_DIR = path.join(__dirname, "..", "data");
const LAST_RUN_PATH = path.join(DATA_DIR, "last-run.json");
const ALERT_TO = "kirkpatrick.kevin.j@gmail.com";

const HEALTH_HEADERS = [
  "Timestamp",
  "Status",
  "Emails Found",
  "Listings Parsed",
  "Scored",
  "Rows Added",
  "Sunsama",
  "Duration (s)",
  "Errors",
];

function writeLastRunFile(stats) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LAST_RUN_PATH, JSON.stringify(stats, null, 2));
}

async function appendHealthRow(auth, stats) {
  const sheets = google.sheets({ version: "v4", auth });
  const spreadsheetId = process.env.SPREADSHEET_ID;
  const tab = "Health";

  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
  let sheet = spreadsheet.data.sheets.find((s) => s.properties.title === tab);
  let sheetId;
  let needsHeader = false;
  if (!sheet) {
    const created = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: tab } } }] },
    });
    sheetId = created.data.replies[0].addSheet.properties.sheetId;
    needsHeader = true;
  } else {
    sheetId = sheet.properties.sheetId;
    const check = await sheets.spreadsheets.values
      .get({ spreadsheetId, range: `'${tab}'!A1:A1` })
      .catch(() => null);
    needsHeader = !check?.data?.values?.length;
  }

  const row = [
    stats.timestamp,
    stats.status,
    stats.emailsFound ?? "",
    stats.listingsParsed ?? "",
    stats.scored ?? "",
    stats.rowsAdded ?? "",
    stats.sunsamaCreated ? "Yes" : "No",
    stats.durationSeconds ?? "",
    (stats.errors || []).join(" | "),
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `'${tab}'!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: needsHeader ? [HEALTH_HEADERS, row] : [row] },
  });

  if (needsHeader) {
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
}

async function sendFailureEmail(auth, errorMessage) {
  try {
    const gmail = google.gmail({ version: "v1", auth });
    const raw = Buffer.from(
      [
        `To: ${ALERT_TO}`,
        `Subject: =?utf-8?B?${Buffer.from("⚠️ Deal scanner failed").toString("base64")}?=`,
        "Content-Type: text/plain; charset=utf-8",
        "",
        `The boring-biz-scanner run failed at ${new Date().toISOString()}:`,
        "",
        errorMessage,
        "",
        "Check logs/scan-listings.log and the Health tab.",
      ].join("\r\n")
    )
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");

    await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
    return true;
  } catch (err) {
    // expected with gmail.readonly-only token (403 insufficient scopes)
    console.error(`  Alert email unavailable (${err.code || err.status || "?"}): falling back to Health tab.`);
    return false;
  }
}

/**
 * Record the run. Never throws — health recording must not kill the process
 * that is reporting on it.
 */
async function recordRun(auth, stats) {
  stats.timestamp = stats.timestamp || new Date().toISOString();
  try {
    writeLastRunFile(stats);
  } catch (err) {
    console.error(`  Could not write last-run.json: ${err.message}`);
  }
  try {
    await appendHealthRow(auth, stats);
    console.log(`  Health recorded: ${stats.status}`);
  } catch (err) {
    console.error(`  Could not write Health tab: ${err.message}`);
  }
}

module.exports = { recordRun, sendFailureEmail };
