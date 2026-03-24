require("dotenv").config();

const { getAuthClient, fetchListingEmails } = require("./src/gmail");
const { parseListingEmail } = require("./src/parser");

async function debug() {
  const auth = getAuthClient();
  const emails = await fetchListingEmails(auth, 30);

  console.log(`Found ${emails.length} emails\n`);

  // show first 5 emails
  for (let i = 0; i < Math.min(5, emails.length); i++) {
    const email = emails[i];
    console.log("=".repeat(80));
    console.log(`EMAIL ${i + 1}: ${email.subject}`);
    console.log(`FROM: ${email.from}`);
    console.log("=".repeat(80));

    // show raw HTML length
    console.log(`\nRaw HTML length: ${email.htmlBody?.length || 0} chars`);

    // show first 500 chars of raw HTML
    console.log(`\n--- RAW HTML (first 500 chars) ---`);
    console.log(email.htmlBody?.substring(0, 500));

    // show what the parser extracts
    const listings = parseListingEmail(email);
    console.log(`\n--- PARSED (${listings.length} listing(s)) ---`);
    for (const listing of listings) {
      console.log(`Title: ${listing.title}`);
      console.log(`Location: ${listing.location}`);
      console.log(`Category: ${listing.category}`);
      console.log(`URL: ${listing.url}`);
      console.log(`\nrawText being sent to Claude:`);
      console.log(listing.rawText?.substring(0, 800));
    }
    console.log("\n");
  }
}

debug().catch(console.error);
