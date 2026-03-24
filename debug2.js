require("dotenv").config();
const { getAuthClient, fetchListingEmails } = require("./src/gmail");
const cheerio = require("cheerio");

async function debug() {
  const auth = getAuthClient();
  const emails = await fetchListingEmails(auth, 30);

  // just look at email 1 in detail
  const email = emails[0];
  console.log(`Subject: ${email.subject}\n`);

  const $ = cheerio.load(email.htmlBody);

  // remove ALL style and script tags first
  $("style").remove();
  $("script").remove();
  $("head").remove();

  // show all links that might be listing URLs
  console.log("=== ALL LINKS ===");
  $("a").each((i, el) => {
    const href = $(el).attr("href") || "";
    const text = $(el).text().trim();
    if (href.includes("bizbuysell") && text.length > 0 && text.length < 200) {
      console.log(`  [${text}] -> ${href}`);
    }
  });

  // now get clean text
  console.log("\n=== CLEAN TEXT (first 2000 chars) ===");
  const text = $("body").text()
    .replace(/[\t ]+/g, " ")
    .replace(/\n\s*\n/g, "\n")
    .replace(/^\s+$/gm, "")
    .split("\n")
    .filter(line => line.trim().length > 2)
    .join("\n")
    .trim();

  console.log(text.substring(0, 2000));

  // also show raw HTML from around the middle where content likely is
  console.log("\n=== RAW HTML chars 10000-12000 ===");
  console.log(email.htmlBody.substring(10000, 12000));
}

debug().catch(console.error);
