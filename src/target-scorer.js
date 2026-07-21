// Scores off-market acquisition targets (businesses NOT for sale) with Claude.
// Batches multiple targets per API call to keep costs down.

const Anthropic = require("@anthropic-ai/sdk").default;

const client = new Anthropic();

const SYSTEM_PROMPT = "You are a JSON-only API. You MUST respond with valid JSON and nothing else. No preamble, no markdown fences, no explanation, no apologies. If you lack information, use null values in the JSON fields. Never refuse. Always return the JSON structure.";

const CHUNK_SIZE = 8;

function buildTargetPrompt(targets) {
  const targetLines = targets
    .map((t, i) => {
      const parts = [
        `${i + 1}. place_id: ${t.placeId}`,
        `   Name: ${t.name}`,
        `   Category searched: ${t.category}${t.primaryType ? ` (Google type: ${t.primaryType})` : ""}`,
        `   Address: ${t.address}`,
        `   Rating: ${t.rating != null ? `${t.rating} (${t.reviewCount || 0} reviews)` : "no rating"}`,
        `   Website: ${t.website || "NONE"}`,
      ];
      return parts.join("\n");
    })
    .join("\n\n");

  return `You are helping a buyer identify high-potential "boring businesses" that are NOT currently for sale, for proactive acquisition outreach (owner letters). These came from a Google Places search.

Buyer profile:
- Liquid capital: $${process.env.BUYER_LIQUID_CAPITAL || "100000"} base plan, stretchable to $${process.env.BUYER_STRETCH_CAPITAL || "200000"} for an exceptional deal; SBA 7(a) financing, open to seller notes
- Goal: replace ~$${process.env.TARGET_INCOME || "200000"}/year of income with full control
- OWNER TIME IS THE HARD CONSTRAINT: at most ${process.env.OWNER_TIME || "2-3 days per week"} — the business must run day-to-day without them
- Max purchase price: $${process.env.MAX_ASKING_PRICE || "750000"}
- Minimum SDE: $${process.env.MIN_SDE || "100000"}
- Wants: durable, recession-resistant businesses that are inherently absentee-operable (laundromat, car wash, storage) OR have enough scale to already have — or clearly afford — a general manager

For EACH business, assess:
1. FIT SCORE (0-10): How well does this specific business fit the "boring business" acquisition thesis? Weight absentee-operability most heavily: inherently absentee categories score high; service businesses score high ONLY when their apparent scale (review volume is a rough proxy) suggests a team and management structure the buyer could keep. Small shops where the owner is clearly the chief operator/technician score low regardless of quality — the buyer has ${process.env.OWNER_TIME || "2-3 days per week"}.
2. SELL SIGNALS: Clues the owner might be open to selling — legacy/family naming, "& Sons", "since 19XX" patterns, categories with aging owner demographics, independent (non-chain) operations. Empty array if none.
3. UPSIDE SIGNALS: Signs of operational neglect that mean optimization potential — no website, weak online presence relative to age/quality, mediocre rating with strong volume. Empty array if none.
4. EST VALUE RANGE: Typical sale price range for a business of this type at apparently this scale. Rough estimate, null if you can't reasonably guess.
5. OUTREACH ANGLE: 1-2 sentences of a personalized angle for an owner letter — specific to this business, not generic.

Chains, franchises of large brands, and businesses obviously too large or too small for the buyer should score low.

Respond with ONLY a JSON array, one object per business, in the same order:
[
  {
    "place_id": "exact place_id from input",
    "fit_score": 0-10,
    "sell_signals": ["..."],
    "upside_signals": ["..."],
    "est_value_range": "$X - $Y" or null,
    "outreach_angle": "...",
    "advisor_take": "1-2 sentences as the buyer's strategic advisor: why this specific business is or isn't worth an owner letter, tied to the income goal and financing reality",
    "notes": "1 sentence, anything else worth knowing"
  }
]

Businesses:

${targetLines}`;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function scoreChunk(targets, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await client.messages.create({
        model: "claude-sonnet-5",
        max_tokens: 4000,
        thinking: { type: "disabled" },
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildTargetPrompt(targets) }],
      });

      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");

      const cleaned = text.replace(/```json\n?|```\n?/g, "").trim();
      const scores = JSON.parse(cleaned);
      if (!Array.isArray(scores)) throw new SyntaxError("Expected JSON array");

      // merge scores back onto targets by place_id, order as fallback
      const byId = new Map(scores.map((s) => [s.place_id, s]));
      return targets.map((t, i) => {
        const s = byId.get(t.placeId) || scores[i] || {};
        return Object.assign({}, t, {
          fit_score: s.fit_score ?? 0,
          sell_signals: Array.isArray(s.sell_signals) ? s.sell_signals : [],
          upside_signals: Array.isArray(s.upside_signals) ? s.upside_signals : [],
          est_value_range: s.est_value_range || null,
          outreach_angle: s.outreach_angle || "",
          advisor_take: s.advisor_take || "",
          notes: s.notes || "",
          scoredAt: new Date().toISOString(),
        });
      });
    } catch (err) {
      const isRateLimit = err.status === 429 || (err.message || "").includes("429");
      const isOverloaded = err.status === 529 || (err.message || "").includes("529");
      const isJsonError =
        err instanceof SyntaxError || (err.message || "").includes("Unexpected token");

      if ((isRateLimit || isOverloaded) && attempt < retries) {
        const wait = attempt * 30000;
        console.log(`    Rate limited/overloaded, waiting ${wait / 1000}s (attempt ${attempt}/${retries})...`);
        await sleep(wait);
        continue;
      }

      if (isJsonError && attempt < retries) {
        console.log(`    Bad JSON response, retrying (attempt ${attempt}/${retries})...`);
        await sleep(2000);
        continue;
      }

      console.error(`    Scoring chunk failed (attempt ${attempt}): ${(err.message || "").substring(0, 80)}`);

      if (attempt === retries) {
        return targets.map((t) =>
          Object.assign({}, t, {
            fit_score: 0,
            sell_signals: [],
            upside_signals: [],
            est_value_range: null,
            outreach_angle: "",
            advisor_take: "",
            notes: `Scoring failed after ${retries} attempts`,
            scoredAt: new Date().toISOString(),
          })
        );
      }
    }
  }
}

async function scoreTargets(targets) {
  const results = [];
  const chunks = [];
  for (let i = 0; i < targets.length; i += CHUNK_SIZE) {
    chunks.push(targets.slice(i, i + CHUNK_SIZE));
  }

  for (let i = 0; i < chunks.length; i++) {
    console.log(`  Scoring batch ${i + 1}/${chunks.length} (${chunks[i].length} targets)...`);
    const scored = await scoreChunk(chunks[i]);
    results.push(...scored);
    if (i < chunks.length - 1) {
      await sleep(3000);
    }
  }

  results.sort((a, b) => (b.fit_score || 0) - (a.fit_score || 0));
  return results;
}

module.exports = { scoreTargets, buildTargetPrompt };
