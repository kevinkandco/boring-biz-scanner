const Anthropic = require("@anthropic-ai/sdk").default;

const client = new Anthropic();

const SYSTEM_PROMPT = "You are a JSON-only API. You MUST respond with valid JSON and nothing else. No preamble, no markdown fences, no explanation, no apologies. If you lack information, use null values in the JSON fields. Never refuse. Always return the JSON structure.";

function buildScoringPrompt() {
  return `Evaluate this business-for-sale listing. The buyer wants a "boring business" that is:

1. ABSENTEE-FRIENDLY (0-10): Can this run without the owner present daily? Laundromats, car washes, self-storage, vending = high. A service business WITH a manager or supervisor in place = medium-high. Restaurants, owner-operator professional services = low.
2. HANDS-OFF (0-10): How little ongoing owner involvement is needed? Coin-op and automated = high. Service businesses with an existing management layer = medium-high. Owner IS the business (license holder, chief technician, main salesperson) = low.
3. OPTIMIZATION POTENTIAL (0-10): Is there obvious upside via pricing, marketing, technology, or operational improvements? Outdated operations = high. Already optimized = low.
4. DURABILITY (0-10): Is demand recession-resistant and not dependent on trends? Essential services = high. Discretionary/trendy = low.

Buyer preferences:
- OWNER TIME IS THE HARD CONSTRAINT: the buyer can commit at most ${process.env.OWNER_TIME || "2-3 days per week"}. Weight absentee and hands-off scores most heavily in the overall score. A business requiring daily owner presence must score 4 or below overall UNLESS the listing states a manager/management team is in place or the business is currently absentee-run.
- Minimum SDE: $${process.env.MIN_SDE || "100000"}
- Preferred region: ${process.env.PREFERRED_REGION || "Seattle, WA"} (within driving distance ideal)
- Max asking price: $${process.env.MAX_ASKING_PRICE || "750000"}

Also detect BUYING SIGNALS — facts in the listing that make this deal materially easier or better for this buyer:
- seller financing offered or "flexible terms"
- manager or key staff in place / currently absentee-run
- real estate included in the price
- long establishment (15+ years) or retiring seller
- recurring/contract revenue
- licensed staff on payroll (matters for trades)
Only list signals actually stated or strongly implied; do not invent.

Respond with ONLY this JSON structure:
{
  "title": "cleaned up business title",
  "business_type": "e.g. laundromat, car wash, dry cleaner",
  "asking_price": number or null,
  "sde": number or null,
  "cash_flow": number or null,
  "revenue": number or null,
  "location": "City, ST" or null,
  "absentee_score": 0-10,
  "handsoff_score": 0-10,
  "optimization_score": 0-10,
  "durability_score": 0-10,
  "overall_score": 0-10,
  "meets_criteria": true/false/null (true only if SDE >= buyer minimum AND asking <= buyer maximum, when both are known; null if financials unknown),
  "signals": ["buying signals detected, from the list above"],
  "deal_notes": "1-2 sentence summary",
  "red_flags": ["list any concerns"],
  "url": "listing URL if available"
}`;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function scoreListing(listing, retries) {
  retries = retries || 3;
  const listingText = listing.needsAiExtraction
    ? listing.rawText
    : formatListingForScoring(listing);

  for (var attempt = 1; attempt <= retries; attempt++) {
    try {
      var response = await client.messages.create({
        model: "claude-sonnet-5",
        max_tokens: 1200,
        thinking: { type: "disabled" },
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: buildScoringPrompt() + "\n\nListing:\n" + listingText,
          },
        ],
      });

      var text = response.content
        .filter(function(b) { return b.type === "text"; })
        .map(function(b) { return b.text; })
        .join("");

      var cleaned = text.replace(/```json\n?|```\n?/g, "").trim();
      var scored = JSON.parse(cleaned);

      return Object.assign({}, scored, {
        source: listing.source,
        emailDate: listing.emailDate,
        url: scored.url || listing.url || null,
        scoredAt: new Date().toISOString(),
      });
    } catch (err) {
      var isRateLimit = (err.message && err.message.indexOf("429") >= 0) || err.status === 429;
      var isOverloaded = (err.message && err.message.indexOf("529") >= 0) || err.status === 529;
      var isJsonError = err.message && err.message.indexOf("Unexpected token") >= 0;

      if ((isRateLimit || isOverloaded) && attempt < retries) {
        var wait = attempt * 30000;
        console.log("  Rate limited/overloaded, waiting " + (wait / 1000) + "s (attempt " + attempt + "/" + retries + ")...");
        await sleep(wait);
        continue;
      }

      if (isJsonError && attempt < retries) {
        console.log("  Bad JSON response, retrying (attempt " + attempt + "/" + retries + ")...");
        await sleep(2000);
        continue;
      }

      console.error("  Error scoring (attempt " + attempt + "): " + (err.message || "").substring(0, 80));

      if (attempt === retries) {
        return {
          title: listing.title || "Parse Error",
          source: listing.source,
          emailDate: listing.emailDate,
          url: listing.url || null,
          overall_score: 0,
          deal_notes: "Scoring failed after " + retries + " attempts",
          red_flags: ["Could not parse/score this listing"],
          scoredAt: new Date().toISOString(),
        };
      }
    }
  }
}

function formatListingForScoring(listing) {
  var parts = [];
  if (listing.title) parts.push("Title: " + listing.title);
  if (listing.source) parts.push("Source: " + listing.source);
  if (listing.askingPrice) parts.push("Asking Price: $" + listing.askingPrice.toLocaleString());
  if (listing.sde) parts.push("SDE: $" + listing.sde.toLocaleString());
  if (listing.cashFlow) parts.push("Cash Flow: $" + listing.cashFlow.toLocaleString());
  if (listing.revenue) parts.push("Revenue: $" + listing.revenue.toLocaleString());
  if (listing.location) parts.push("Location: " + listing.location);
  if (listing.category) parts.push("Category: " + listing.category);
  if (listing.url) parts.push("URL: " + listing.url);
  if (listing.rawText) parts.push("\nFull description:\n" + listing.rawText);
  return parts.join("\n");
}

async function scoreListings(listings) {
  var results = [];

  for (var i = 0; i < listings.length; i++) {
    var listing = listings[i];
    console.log("  Scoring [" + (i + 1) + "/" + listings.length + "]: " + (listing.title || listing.source || "unknown"));
    var result = await scoreListing(listing);
    results.push(result);

    // 3s delay between requests to stay under rate limits
    if (i < listings.length - 1) {
      await sleep(3000);
    }
  }

  results.sort(function(a, b) { return (b.overall_score || 0) - (a.overall_score || 0); });
  return results;
}

module.exports = { scoreListings: scoreListings, scoreListing: scoreListing };
