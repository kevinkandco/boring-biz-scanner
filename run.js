require("dotenv").config();

const { getAuthClient, fetchListingEmails } = require("./src/gmail");
const { parseListingEmail } = require("./src/parser");
const { scoreListings } = require("./src/scorer");
const { fetchListingPage } = require("./src/fetcher");
const { deepAnalyzeListings } = require("./src/deep-analyzer");
const { writeToSheet, getKnownListings } = require("./src/sheets");
const { cleanDealFlow } = require("./src/sheet-maintenance");
const { upsertDailyDigest, buildOnMarketSection } = require("./src/sunsama");

async function run() {
  const startTime = Date.now();
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run") || !!process.env.DRY_RUN;
  const daysBack = parseInt(args.find((a) => /^\d+$/.test(a)) || "7", 10);

  console.log(`\n🔍 Boring Business Scanner${dryRun ? " (DRY RUN)" : ""}`);
  console.log(`  Scanning last ${daysBack} days of email alerts...\n`);
  if (dryRun) {
    console.log("  Dry run: nothing will be written to Sheets or Sunsama.\n");
  }

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

  // skip listings we've already scored (active or archived) — no point paying twice
  const known = await getKnownListings(auth);
  const freshListings = allListings.filter((l) => {
    if (l.url && known.urls.has(l.url)) return false;
    if (l.title && known.titles.has(l.title.toLowerCase())) return false;
    return true;
  });
  const skipped = allListings.length - freshListings.length;
  if (skipped > 0) console.log(`  Skipping ${skipped} already-scored listing(s)`);

  if (freshListings.length === 0) {
    console.log("  Nothing new to score.\n");
    return;
  }

  // 4. score with Claude
  console.log("\n4. Scoring listings with Claude...");
  const scored = await scoreListings(freshListings);
  console.log(`  Scored ${scored.length} listings`);

  const passing = scored.filter((s) => s.overall_score >= 6);
  console.log(`  ${passing.length} scored 6+ (worth a look)`);

  // 5. deep analysis for high scorers
  if (passing.length > 0) {
    console.log("\n5. Deep analysis for listings scoring 6+...");

    // fetch full listing pages where we have a URL
    for (const listing of passing) {
      if (listing.url) {
        console.log(`  Fetching full listing: ${listing.title || listing.url}`);
        const page = await fetchListingPage(listing.url);
        if (page) {
          listing.fullDescription = page.fullDescription;
          listing.pageFinancials = page.financials;
        }
      }
    }

    const analyzed = await deepAnalyzeListings(passing);

    // passing holds the same object references as scored, so merging in place
    // updates the scored list too
    analyzed.forEach((a, i) => Object.assign(passing[i], a));
  } else {
    console.log("\n5. No listings scored 6+, skipping deep analysis.");
  }

  // 6. write to Google Sheets
  let result;
  if (dryRun) {
    console.log("\n6. [DRY RUN] Rows that would be written to Google Sheets:");
    for (const l of scored) {
      const verdict = l.go_no_go ? ` — ${l.go_no_go}` : "";
      console.log(`  [${l.overall_score}/10] ${l.title || "Untitled"}${verdict}`);
      if (l.dscr != null || l.sde_multiple != null) {
        const bits = [];
        if (l.sde_multiple != null) bits.push(`SDE multiple ${l.sde_multiple}x`);
        if (l.dscr != null) bits.push(`DSCR ${l.dscr}`);
        if (l.sba_monthly_payment) bits.push(`SBA payment $${l.sba_monthly_payment.toLocaleString()}/mo`);
        console.log(`      ${bits.join(" · ")}`);
      }
    }
    result = { added: 0, duplicates: 0, newListings: scored };
  } else {
    console.log("\n6. Writing to Google Sheets...");
    result = await writeToSheet(auth, scored);
    const cleaned = await cleanDealFlow(auth);
    console.log(
      `  Sheet cleaned: ${cleaned.kept} active, ${cleaned.archived} archived` +
        (cleaned.migrated ? `, ${cleaned.migrated} migrated` : "")
    );
  }

  // 7. add On Market section to today's Sunsama digest
  // only surface listings that score well AND meet hard criteria (SDE/price)
  const newPassing = result.newListings.filter(
    (l) => l.overall_score >= 6 && l.meets_criteria !== false
  );
  if (dryRun) {
    console.log("\n7. [DRY RUN] On Market digest section that would be sent:");
    if (newPassing.length > 0) {
      console.log(buildOnMarketSection(newPassing).split("\n").map((line) => "    " + line).join("\n"));
    } else {
      console.log("  (none — no new listings scored 6+ and met criteria)");
    }
  } else {
    console.log("\n7. Updating Sunsama digest...");
    if (newPassing.length > 0) {
      await upsertDailyDigest(buildOnMarketSection(newPassing), { timeEstimate: 15 });
    } else {
      console.log("  No new listings scored 6+ and met criteria, skipping digest.");
    }
  }

  // summary
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✅ Done in ${elapsed}s${dryRun ? " (dry run — nothing written)" : ""}`);
  if (!dryRun) {
    console.log(`  ${result.added} new listings added to sheet`);
    console.log(`  ${result.duplicates} duplicates skipped`);
  }

  if (passing.length > 0) {
    console.log(`\n🏆 Top picks:`);
    for (const pick of passing.slice(0, 5)) {
      console.log(
        `  [${pick.overall_score}/10] ${pick.title} — ${pick.location || "Location N/A"}`
      );
      if (pick.go_no_go) console.log(`    Verdict: ${pick.go_no_go}`);
      console.log(`    ${pick.deal_summary || pick.deal_notes}`);
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
