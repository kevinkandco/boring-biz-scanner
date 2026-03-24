require("dotenv").config();

const { getAuthClient, fetchListingEmails } = require("./src/gmail");
const { parseListingEmail } = require("./src/parser");
const { scoreListings } = require("./src/scorer");
const { writeToSheet } = require("./src/sheets");

async function run() {
  const startTime = Date.now();
  const daysBack = parseInt(process.argv[2] || "7", 10);

  console.log(`\n🔍 Boring Business Scanner`);
  console.log(`  Scanning last ${daysBack} days of email alerts...\n`);

  // 1. authenticate
  console.log("1. Authenticating with Google...");
  const auth = getAuthClient();

  // 2. fetch emails
  console.log("\n2. Fetching listing alert emails...");
  const emails = await fetchListingEmails(auth, daysBack);
  if (emails.length === 0) {
    console.log("\n  No listing emails found. Make sure you've set up saved");
    console.log("  search alerts on BizBuySell, BizQuest, etc.");
    console.log("  See SETUP.md for instructions.\n");
    return;
  }

  // 3. parse listings from emails
  console.log("\n3. Parsing listings from emails...");
  const allListings = [];
  for (const email of emails) {
    const listings = parseListingEmail(email);
    allListings.push(...listings);
    if (listings.length > 0) {
      console.log(
        `  ${email.source}: ${listings.length} listing(s) from "${email.subject}"`
      );
    }
  }

  if (allListings.length === 0) {
    console.log("  No parseable listings found in emails.");
    console.log("  This might mean the email format has changed.");
    console.log("  Try running with DEBUG=1 to see raw email content.\n");
    return;
  }

  console.log(`\n  Total listings found: ${allListings.length}`);

  // 4. score with Claude
  console.log("\n4. Scoring listings with Claude...");
  const scored = await scoreListings(allListings);
  console.log(`  Scored ${scored.length} listings`);

  // quick summary
  const passing = scored.filter((s) => s.overall_score >= 6);
  console.log(`  ${passing.length} scored 6+ (worth a look)`);

  // 5. write to Google Sheets
  console.log("\n5. Writing to Google Sheets...");
  const result = await writeToSheet(auth, scored);

  // summary
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✅ Done in ${elapsed}s`);
  console.log(`  ${result.added} new listings added to sheet`);
  console.log(`  ${result.duplicates} duplicates skipped`);

  if (passing.length > 0) {
    console.log(`\n🏆 Top picks:`);
    for (const pick of passing.slice(0, 5)) {
      console.log(
        `  [${pick.overall_score}/10] ${pick.title} — ${pick.location || "Location N/A"}`
      );
      console.log(`    ${pick.deal_notes}`);
    }
  }

  console.log(
    `\n  Sheet: https://docs.google.com/spreadsheets/d/${process.env.SPREADSHEET_ID}\n`
  );
}

run().catch((err) => {
  console.error("\n❌ Error:", err.message);
  if (process.env.DEBUG) console.error(err);
  process.exit(1);
});
