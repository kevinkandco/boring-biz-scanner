const { google } = require("googleapis");

const HEADERS = [
  "Score",
  "Go/No-Go",
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
  "SDE Multiple",
  "Valuation",
  "SBA Down Payment",
  "Monthly Payment",
  "DSCR",
  "SBA Feasible",
  "Optimizations",
  "Absentee Realistic",
  "Manager Cost",
  "Deal Summary",
  "Red Flags",
  "Source",
  "URL",
  "Email Date",
  "Scored At",
  "Signals",
  "Advisor Take",
  "Next Action",
  "Broker Questions",
  "Walk-Away Price",
];

const TITLE_COL = HEADERS.indexOf("Title");
const URL_COL = HEADERS.indexOf("URL");
const LAST_COL = "AG"; // 33 columns: A..AG

function money(n) {
  return n != null ? `$${n.toLocaleString()}` : "";
}

function yesNo(v) {
  return v === true ? "Yes" : v === false ? "No" : "Unknown";
}

function formatOptimizations(opts) {
  if (!Array.isArray(opts)) return "";
  return opts
    .map((o) => {
      const extras = [o.impact, o.timeframe].filter(Boolean).join(", ");
      return extras ? `${o.opportunity} (${extras})` : o.opportunity;
    })
    .join("; ");
}

// URLs and titles of everything ever scored (active + archived) so scans can
// skip re-scoring known listings — the single biggest API cost saver.
async function getKnownListings(auth) {
  const sheets = google.sheets({ version: "v4", auth });
  const spreadsheetId = process.env.SPREADSHEET_ID;
  const urls = new Set();
  const titles = new Set();

  for (const tab of ["Deal Flow", "Archive"]) {
    try {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${tab}'!A:${LAST_COL}`,
      });
      const rows = res.data.values || [];
      for (const row of rows.slice(1)) {
        if (row[URL_COL]) urls.add(row[URL_COL]);
        if (row[TITLE_COL]) titles.add(row[TITLE_COL].toLowerCase());
      }
    } catch {
      // tab may not exist yet
    }
  }

  return { urls, titles };
}

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

  // filter out duplicates — checks active AND archived listings
  const known = await getKnownListings(auth);
  const newListings = scoredListings.filter((l) => {
    if (l.url && known.urls.has(l.url)) return false;
    if (l.title && known.titles.has(l.title.toLowerCase())) return false;
    return true;
  });

  if (newListings.length === 0) {
    console.log("  No new listings to add (all duplicates).");
    return { added: 0, duplicates: scoredListings.length, newListings: [] };
  }

  // check if headers exist
  let hasHeaders = false;
  try {
    const headerCheck = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${sheetName}'!A1:${LAST_COL}1`,
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
      l.go_no_go || "",
      l.title || "",
      l.business_type || "",
      money(l.asking_price),
      money(l.sde),
      money(l.cash_flow),
      money(l.revenue),
      l.location || "",
      l.absentee_score || "",
      l.handsoff_score || "",
      l.optimization_score || "",
      l.durability_score || "",
      l.sde_multiple != null ? `${l.sde_multiple}x` : "",
      [l.valuation, l.suggested_offer_range ? `offer ${l.suggested_offer_range}` : null]
        .filter(Boolean)
        .join("; "),
      money(l.sba_down_payment),
      money(l.sba_monthly_payment),
      l.dscr != null ? l.dscr : "",
      l.sba_feasible != null ? yesNo(l.sba_feasible) : "",
      formatOptimizations(l.optimizations),
      l.absentee_realistic != null ? yesNo(l.absentee_realistic) : "",
      money(l.estimated_manager_cost),
      l.deal_summary || "",
      Array.isArray(l.red_flags) ? l.red_flags.join("; ") : "",
      l.source || "",
      l.url || "",
      l.emailDate || "",
      l.scoredAt || "",
      Array.isArray(l.signals) ? l.signals.join("; ") : "",
      l.advisor_take || "",
      l.next_action || "",
      Array.isArray(l.questions_for_broker) ? l.questions_for_broker.join(" | ") : "",
      money(l.walk_away_price),
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
                endIndex: HEADERS.length,
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
    newListings,
  };
}

module.exports = { writeToSheet, getKnownListings };
