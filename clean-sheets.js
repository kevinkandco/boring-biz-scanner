// Normalizes and cleans the spreadsheet: migrates legacy rows, archives stale
// listings and weak targets, sorts everything best-first.
// Runs automatically after each scan; run manually anytime: npm run clean

require("dotenv").config();

const { getAuthClient } = require("./src/gmail");
const { cleanDealFlow, cleanTargets } = require("./src/sheet-maintenance");

async function run() {
  const auth = getAuthClient();

  console.log("Cleaning Deal Flow tab...");
  const deals = await cleanDealFlow(auth);
  console.log(
    `  ${deals.kept} kept, ${deals.archived} archived` +
      (deals.migrated ? `, ${deals.migrated} legacy rows migrated to current layout` : "")
  );

  console.log("Cleaning Targets tab...");
  const targets = await cleanTargets(auth);
  console.log(`  ${targets.kept} kept, ${targets.archived} weak targets archived`);

  console.log("\nDone.");
}

run().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
