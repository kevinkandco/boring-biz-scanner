// Off-market target sourcing: finds high-potential "boring businesses" that
// are NOT for sale, scores them with Claude, and tracks them in a Targets tab.
//
// Usage:
//   node scan-targets.js              # search, score, write to sheet
//   node scan-targets.js --dry-run    # search + score, print instead of write
//
// Config (.env):
//   GOOGLE_PLACES_API_KEY   required
//   TARGET_CATEGORIES       comma-separated, default below
//   TARGET_REGION           defaults to PREFERRED_REGION
//   TARGETS_PER_CATEGORY    default 20

require("dotenv").config();

const { searchTargets } = require("./src/places");
const { scoreTargets } = require("./src/target-scorer");
const { writeTargetsToSheet } = require("./src/targets-sheet");
const { getAuthClient } = require("./src/gmail");
const { cleanTargets } = require("./src/sheet-maintenance");
const { prefilterTargets, summarizeDropped } = require("./src/prefilter");
const { upsertDailyDigest, buildOffMarketSection } = require("./src/sunsama");

const DEFAULT_CATEGORIES = [
  "laundromat",
  "car wash",
  "self storage",
  "auto repair shop",
  "HVAC contractor",
];

async function run() {
  const startTime = Date.now();
  const dryRun = process.argv.includes("--dry-run") || !!process.env.DRY_RUN;

  const categories = (process.env.TARGET_CATEGORIES || DEFAULT_CATEGORIES.join(","))
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  // regions are pipe-separated since region names contain commas ("Tacoma, WA|Boise, ID")
  const regions = (
    process.env.TARGET_REGION || process.env.PREFERRED_REGION || "Seattle, WA"
  )
    .split("|")
    .map((r) => r.trim())
    .filter(Boolean);
  const perCategory = parseInt(process.env.TARGETS_PER_CATEGORY || "20", 10);

  console.log(`\n🎯 Off-Market Target Scanner${dryRun ? " (DRY RUN)" : ""}`);
  console.log(`  Regions: ${regions.join(" | ")}`);
  console.log(`  Categories: ${categories.join(", ")}`);
  console.log(`  Up to ${perCategory} per category per region\n`);

  if (!process.env.GOOGLE_PLACES_API_KEY) {
    console.log("❌ GOOGLE_PLACES_API_KEY is not set.\n");
    console.log("  1. Go to https://console.cloud.google.com (same project as Gmail OAuth)");
    console.log('  2. Enable "Places API (New)"');
    console.log("  3. Credentials → Create Credentials → API key");
    console.log("  4. Add GOOGLE_PLACES_API_KEY=<key> to .env\n");
    process.exit(1);
  }

  // 1. search Google Places across all regions
  console.log("1. Searching Google Places...");
  const targets = [];
  const seenIds = new Set();
  for (const region of regions) {
    const regionTargets = await searchTargets(categories, region, {
      maxResults: perCategory,
    });
    for (const t of regionTargets) {
      if (seenIds.has(t.placeId)) continue;
      seenIds.add(t.placeId);
      targets.push(t);
    }
  }
  console.log(`\n  Total unique businesses: ${targets.length}`);

  if (targets.length === 0) {
    console.log("  Nothing found — check region/categories.\n");
    return;
  }

  // 2. deterministic pre-filter — drop franchises and obvious non-fits for free
  const { kept, dropped } = prefilterTargets(targets);
  if (dropped.length > 0) {
    console.log(`  Pre-filter dropped ${dropped.length}: ${summarizeDropped(dropped)}`);
  }
  console.log(`  ${kept.length} targets go to scoring`);

  if (kept.length === 0) {
    console.log("  Nothing survived the pre-filter.\n");
    return;
  }

  // 3. score with Claude
  console.log("\n2. Scoring targets with Claude...");
  const scored = await scoreTargets(kept);
  const strong = scored.filter((t) => t.fit_score >= 7);
  console.log(`  ${strong.length} scored 7+ (strong targets)`);

  // 3. write to sheet (or preview)
  let result;
  if (dryRun) {
    console.log("\n3. [DRY RUN] Targets that would be written to the sheet:");
    for (const t of scored) {
      console.log(`  [${t.fit_score}/10] ${t.name} — ${t.category} (${t.region})`);
      if (t.sell_signals.length > 0) console.log(`      Sell signals: ${t.sell_signals.join("; ")}`);
      if (t.upside_signals.length > 0) console.log(`      Upside: ${t.upside_signals.join("; ")}`);
      if (t.est_value_range) console.log(`      Est. value: ${t.est_value_range}`);
      if (t.outreach_angle) console.log(`      Angle: ${t.outreach_angle}`);
    }
    result = { added: 0, duplicates: 0, newTargets: scored };
  } else {
    console.log("\n3. Writing to Google Sheets (Targets tab)...");
    const auth = getAuthClient();
    result = await writeTargetsToSheet(auth, scored);
    const cleaned = await cleanTargets(auth);
    console.log(`  Sheet cleaned: ${cleaned.kept} active, ${cleaned.archived} weak targets archived`);
  }

  // 4. add Off Market section to today's Sunsama digest (top 20 new 7+ targets)
  const strongNew = result.newTargets
    .filter((t) => t.fit_score >= 7)
    .slice(0, 20);
  if (dryRun) {
    console.log("\n4. [DRY RUN] Off Market digest section that would be sent:");
    if (strongNew.length > 0) {
      console.log(`  ${strongNew.length} targets (7+ scores only, capped at 20)`);
    } else {
      console.log("  (none — no targets scored 7+)");
    }
  } else {
    console.log("\n4. Updating Sunsama digest...");
    if (strongNew.length > 0) {
      await upsertDailyDigest(buildOffMarketSection(strongNew), { timeEstimate: 25 });
    } else {
      console.log("  No new targets scored 7+, skipping digest.");
    }
  }

  // summary
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✅ Done in ${elapsed}s${dryRun ? " (dry run — nothing written)" : ""}`);
  if (!dryRun) {
    console.log(`  ${result.added} new targets added`);
    console.log(`  ${result.duplicates} already tracked`);
  }

  if (strong.length > 0) {
    console.log(`\n🏆 Top targets:`);
    for (const t of strong.slice(0, 5)) {
      console.log(`  [${t.fit_score}/10] ${t.name} — ${t.address}`);
      if (t.outreach_angle) console.log(`    ${t.outreach_angle}`);
    }
  }

  if (!dryRun) {
    console.log(
      `\n  Sheet: https://docs.google.com/spreadsheets/d/${process.env.SPREADSHEET_ID}\n`
    );
  }
}

run().catch((err) => {
  console.error("\n❌ Error:", err.message);
  if (process.env.DEBUG) console.error(err);
  process.exit(1);
});
