// Sends the Sunsama review task from targets already written to the Targets tab.
// Use after a scan whose Sunsama step failed, or to re-send a digest.
//
//   node send-targets-digest.js            # create the Sunsama task
//   node send-targets-digest.js --dry-run  # preview the task instead

require("dotenv").config();

const { google } = require("googleapis");
const { getAuthClient } = require("./src/gmail");
const { upsertDailyDigest, buildOffMarketSection } = require("./src/sunsama");

const MIN_FIT = 7;
const MAX_TARGETS = 20;

async function readTargets() {
  const auth = getAuthClient();
  const sheets = google.sheets({ version: "v4", auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: "'Targets'!A:R",
  });

  const rows = res.data.values || [];
  if (rows.length < 2) return [];

  const header = rows[0];
  const col = (name) => header.indexOf(name);

  return rows.slice(1).map((r) => ({
    fit_score: parseInt(r[col("Fit Score")], 10) || 0,
    name: r[col("Name")] || "",
    category: r[col("Category")] || "",
    region: r[col("Region")] || "",
    address: r[col("Address")] || "",
    rating: r[col("Rating")] ? parseFloat(r[col("Rating")]) : null,
    reviewCount: r[col("Reviews")] ? parseInt(r[col("Reviews")], 10) : null,
    website: r[col("Website")] || null,
    sell_signals: r[col("Sell Signals")] ? r[col("Sell Signals")].split("; ") : [],
    upside_signals: r[col("Upside Signals")] ? r[col("Upside Signals")].split("; ") : [],
    est_value_range: r[col("Est. Value")] || null,
    outreach_angle: r[col("Outreach Angle")] || "",
    advisor_take: col("Advisor Take") >= 0 ? r[col("Advisor Take")] || "" : "",
    mapsUrl: r[col("Maps URL")] || null,
  }));
}

async function run() {
  const dryRun = process.argv.includes("--dry-run");

  console.log("Reading Targets tab...");
  const all = await readTargets();
  const strong = all
    .filter((t) => t.fit_score >= MIN_FIT)
    .sort((a, b) => b.fit_score - a.fit_score)
    .slice(0, MAX_TARGETS);

  console.log(`  ${all.length} targets in sheet, ${strong.length} selected (${MIN_FIT}+, capped at ${MAX_TARGETS})`);

  if (strong.length === 0) {
    console.log("  Nothing to send.");
    return;
  }

  const section = buildOffMarketSection(strong);
  if (dryRun) {
    console.log(`\n[DRY RUN] Off Market section:\n\n${section}`);
  } else {
    await upsertDailyDigest(section, { timeEstimate: 25 });
  }
}

run().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
