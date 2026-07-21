// Outreach engine: drafts personalized owner letters for off-market targets.
// Reads the Targets tab, writes one markdown file per letter to outreach/,
// and tracks what's been drafted so re-runs only cover new targets.
//
//   node generate-letters.js                 # draft letters for top 10 (fit 8+)
//   node generate-letters.js --top 5         # fewer
//   node generate-letters.js --min-fit 7     # lower bar
//   node generate-letters.js --region Tacoma # one market only
//   node generate-letters.js --dry-run       # print letters, write nothing
//
// Letters are drafts for YOU to review and mail — nothing is sent anywhere.

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
const Anthropic = require("@anthropic-ai/sdk").default;
const { getAuthClient } = require("./src/gmail");

const client = new Anthropic();

const OUTREACH_DIR = path.join(__dirname, "outreach");
const LOG_PATH = path.join(OUTREACH_DIR, "letters-log.json");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").substring(0, 60);
}

function cityFromAddress(address) {
  const parts = (address || "").split(",").map((p) => p.trim());
  return parts.length >= 2 ? parts[parts.length - 3] || parts[0] : "";
}

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
    phone: r[col("Phone")] || null,
    sell_signals: r[col("Sell Signals")] ? r[col("Sell Signals")].split("; ") : [],
    est_value_range: r[col("Est. Value")] || null,
    outreach_angle: r[col("Outreach Angle")] || "",
    advisor_take: col("Advisor Take") >= 0 ? r[col("Advisor Take")] || "" : "",
    placeId: r[col("Place ID")] || "",
  }));
}

function buildLetterPrompt(t) {
  const buyerName = process.env.BUYER_NAME || "Kevin";
  const buyerContact = process.env.BUYER_CONTACT || "";
  const city = cityFromAddress(t.address);

  return `Draft a physical owner-outreach letter for this buyer to mail to a small business owner. The buyer found the business through their own local research; the owner has NOT listed it for sale.

Buyer: ${buyerName}, a Seattle-based individual buyer (not a broker, not private equity) looking to buy and personally own one great local business for the long term. Contact: ${buyerContact}

Business:
- Name: ${t.name}
- Type: ${t.category}
- City: ${city || t.region}
- Standing: ${t.rating != null ? `${t.rating} stars across ${t.reviewCount} public reviews` : "well-regarded locally"}
${t.sell_signals.length > 0 ? `- Context: ${t.sell_signals.join("; ")}` : ""}
${t.outreach_angle ? `- Suggested angle: ${t.outreach_angle}` : ""}

Rules:
- 150-220 words, warm and plain-spoken; sounds like a person, not a firm
- Reference the business's specific reputation and standing in its community naturally — never cite data, review counts, or anything that sounds researched or scraped
- NEVER mention: prices, valuations, financing, their weaknesses, or that they might want to retire (let them draw that conclusion)
- Make clear: individual buyer, would personally own and care for the business, team and name stay, completely confidential, zero pressure, fine if the timing is never
- One ask: a brief phone call or coffee, on their schedule
- Sign off with the buyer's first name and contact line
- Respond with ONLY the letter body text - no subject line, no placeholder brackets, no commentary`;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function draftLetter(t, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await client.messages.create({
        model: "claude-sonnet-5",
        max_tokens: 800,
        thinking: { type: "disabled" },
        messages: [{ role: "user", content: buildLetterPrompt(t) }],
      });
      return response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
    } catch (err) {
      const retryable = err.status === 429 || err.status === 529;
      if (retryable && attempt < retries) {
        await sleep(attempt * 20000);
        continue;
      }
      throw err;
    }
  }
}

function letterFile(t) {
  return path.join(OUTREACH_DIR, `${slugify(t.name)}--${slugify(t.region)}.md`);
}

async function run() {
  const dryRun = process.argv.includes("--dry-run");
  const top = parseInt(arg("--top", "10"), 10);
  const minFit = parseInt(arg("--min-fit", "8"), 10);
  const regionFilter = arg("--region", null);

  console.log(`\n✉️  Outreach Letter Generator${dryRun ? " (DRY RUN)" : ""}`);
  console.log(`  Selecting: fit ${minFit}+, top ${top}${regionFilter ? `, region ~ "${regionFilter}"` : ""}\n`);

  fs.mkdirSync(OUTREACH_DIR, { recursive: true });
  const log = fs.existsSync(LOG_PATH) ? JSON.parse(fs.readFileSync(LOG_PATH, "utf-8")) : {};

  const all = await readTargets();
  const candidates = all
    .filter((t) => t.fit_score >= minFit)
    .filter((t) => !regionFilter || t.region.toLowerCase().includes(regionFilter.toLowerCase()))
    .filter((t) => !log[t.placeId])
    .sort((a, b) => b.fit_score - a.fit_score)
    .slice(0, top);

  const alreadyDrafted = Object.keys(log).length;
  console.log(`  ${all.length} targets in sheet, ${alreadyDrafted} already drafted, ${candidates.length} selected\n`);

  if (candidates.length === 0) {
    console.log("  Nothing new to draft.\n");
    return;
  }

  for (let i = 0; i < candidates.length; i++) {
    const t = candidates[i];
    console.log(`  Drafting [${i + 1}/${candidates.length}]: ${t.name} (${t.region})`);
    try {
      const letter = await draftLetter(t);

      const doc = [
        `# ${t.name}`,
        ``,
        `- **Fit**: ${t.fit_score}/10 · ${t.category} · ${t.region}`,
        `- **Address**: ${t.address}`,
        `- **Phone**: ${t.phone || "—"} · **Website**: ${t.website || "none"}`,
        `- **Standing**: ${t.rating != null ? `${t.rating}★ (${t.reviewCount} reviews)` : "—"}`,
        `- **Est. value**: ${t.est_value_range || "—"}`,
        t.advisor_take ? `- **Advisor take**: ${t.advisor_take}` : null,
        ``,
        `---`,
        ``,
        letter,
        ``,
      ].filter((l) => l !== null).join("\n");

      if (dryRun) {
        console.log("\n" + doc + "\n");
      } else {
        fs.writeFileSync(letterFile(t), doc);
        log[t.placeId] = {
          name: t.name,
          region: t.region,
          file: path.basename(letterFile(t)),
          draftedAt: new Date().toISOString(),
        };
        fs.writeFileSync(LOG_PATH, JSON.stringify(log, null, 2));
      }
    } catch (err) {
      console.error(`    Failed: ${(err.message || "").substring(0, 100)}`);
    }
    if (i < candidates.length - 1) await sleep(2000);
  }

  if (!dryRun) {
    console.log(`\n✅ Letters in ${OUTREACH_DIR}/ — review, edit, and mail on your schedule.`);
  }
}

run().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
