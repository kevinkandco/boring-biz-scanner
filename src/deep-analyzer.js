const Anthropic = require("@anthropic-ai/sdk").default;

const client = new Anthropic();

const SYSTEM_PROMPT = "You are a JSON-only API. You MUST respond with valid JSON and nothing else. No preamble, no markdown fences, no explanation, no apologies. If you lack information, use null values in the JSON fields. Never refuse. Always return the JSON structure.";

// SBA 7(a) assumptions: 10% down, 10-year term, 10.5% rate
const SBA_DOWN_PCT = 0.1;
const SBA_RATE = 0.105;
const SBA_TERM_YEARS = 10;

function computeSbaTerms(askingPrice) {
  if (!askingPrice || askingPrice <= 0) return null;
  const downPayment = Math.round(askingPrice * SBA_DOWN_PCT);
  const loanAmount = askingPrice - downPayment;
  const r = SBA_RATE / 12;
  const n = SBA_TERM_YEARS * 12;
  const monthlyPayment = Math.round(
    (loanAmount * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1)
  );
  return { downPayment, loanAmount, monthlyPayment, annualDebtService: monthlyPayment * 12 };
}

function computeDscr(annualCashFlow, annualDebtService) {
  if (!annualCashFlow || !annualDebtService) return null;
  return Math.round((annualCashFlow / annualDebtService) * 100) / 100;
}

function buildAnalysisPrompt(listing, sba, dscr) {
  const earnings = listing.sde || listing.cash_flow;
  const sdeMultiple =
    listing.asking_price && earnings
      ? Math.round((listing.asking_price / earnings) * 10) / 10
      : null;

  const sbaFacts = sba
    ? `Pre-computed SBA 7(a) loan terms (10% down, ${SBA_TERM_YEARS}yr term, ${(SBA_RATE * 100).toFixed(1)}% rate):
- Down payment: $${sba.downPayment.toLocaleString()}
- Loan amount: $${sba.loanAmount.toLocaleString()}
- Monthly payment: $${sba.monthlyPayment.toLocaleString()}
- Annual debt service: $${sba.annualDebtService.toLocaleString()}
- DSCR (annual cash flow / annual debt service): ${dscr != null ? dscr : "unknown — cash flow not available"}
${sdeMultiple != null ? `- Implied SDE multiple: ${sdeMultiple}x` : ""}`
    : "SBA terms could not be computed (no asking price available).";

  return `You are analyzing a business-for-sale listing for a buyer seeking a "boring business" they can run semi-absentee. This is a second-pass deep analysis; the listing already scored well on an initial screen.

Buyer profile:
- Liquid capital: $${process.env.BUYER_LIQUID_CAPITAL || "100000"} is the base plan (down payment + fees + working capital); up to $${process.env.BUYER_STRETCH_CAPITAL || "200000"} total is available but ONLY for an exceptional deal — do not assume the stretch by default; when a deal is strong but needs more than the base capital, say so explicitly in the advisor take and justify why it earns the stretch
- Goal: replace ~$${process.env.TARGET_INCOME || "200000"}/year of income with full control of the business
- OWNER TIME: at most ${process.env.OWNER_TIME || "2-3 days per week"} — daily operations must be covered by existing staff, a manager kept from the seller, or a hired GM
- Minimum SDE: $${process.env.MIN_SDE || "100000"}
- Preferred region: ${process.env.PREFERRED_REGION || "Seattle, WA"}
- Max asking price: $${process.env.MAX_ASKING_PRICE || "750000"}
- Financing: SBA 7(a) loan, 10% down; open to seller notes on standby to stretch the injection

${sbaFacts}

Analyze:
1. VALUATION: Is the asking price fair, overpriced, or underpriced given the SDE multiple and what businesses of this type typically sell for? Suggest an offer range.
2. SBA FEASIBILITY: Using the pre-computed loan terms above, is this deal financeable? A DSCR of 1.25+ is generally considered bankable; below 1.15 is a hard no for most lenders.
3. COMPARABLE BENCHMARKS: What do businesses of this type typically sell for (SDE multiple range), and how does this listing compare?
4. OPTIMIZATION OPPORTUNITIES: 3-5 specific, actionable opportunities to increase revenue or cut costs, each with estimated impact and timeframe.
5. ABSENTEE ASSESSMENT: Can THIS business genuinely run on ${process.env.OWNER_TIME || "2-3 days per week"} of owner time? Base this on what the listing actually says about staff, managers, and current owner involvement — not on category stereotypes. If a manager must be hired, estimate the annual cost and subtract it (along with debt service) when judging whether the deal still reaches the buyer's income goal.
6. VERDICT: strong buy / worth exploring / proceed with caution / pass.

Respond with ONLY this JSON structure:
{
  "sde_multiple": number or null,
  "valuation": "underpriced" | "fair" | "overpriced" | null,
  "valuation_notes": "1-2 sentences",
  "suggested_offer_range": "$X - $Y" or null,
  "comparable_benchmark": "typical multiple range for this business type and how this deal compares",
  "sba_feasible": true | false | null,
  "sba_notes": "1-2 sentences on financeability",
  "optimizations": [
    { "opportunity": "specific action", "impact": "estimated $ or % impact", "timeframe": "e.g. 0-6 months" }
  ],
  "absentee_realistic": true | false | null,
  "absentee_notes": "1-2 sentences",
  "estimated_manager_cost": number or null,
  "go_no_go": "strong buy" | "worth exploring" | "proceed with caution" | "pass",
  "deal_summary": "2-3 sentence overall assessment",
  "advisor_take": "2-3 sentences in the voice of the buyer's strategic advisor: WHY this deal does or doesn't get them to their income goal given their cash AND their ${process.env.OWNER_TIME || "2-3 days per week"} availability (net income after debt service and any manager cost), the single biggest risk, and the concrete next action (e.g. 'request P&L', 'ask if the manager stays', 'pass')"
}`;
}

function formatListingForAnalysis(listing) {
  const parts = [];
  if (listing.title) parts.push(`Title: ${listing.title}`);
  if (listing.business_type) parts.push(`Business type: ${listing.business_type}`);
  if (listing.location) parts.push(`Location: ${listing.location}`);
  if (listing.asking_price) parts.push(`Asking price: $${listing.asking_price.toLocaleString()}`);
  if (listing.sde) parts.push(`SDE: $${listing.sde.toLocaleString()}`);
  if (listing.cash_flow) parts.push(`Cash flow: $${listing.cash_flow.toLocaleString()}`);
  if (listing.revenue) parts.push(`Revenue: $${listing.revenue.toLocaleString()}`);
  if (listing.deal_notes) parts.push(`Initial screen notes: ${listing.deal_notes}`);
  if (Array.isArray(listing.red_flags) && listing.red_flags.length > 0) {
    parts.push(`Red flags from initial screen: ${listing.red_flags.join("; ")}`);
  }

  const f = listing.pageFinancials;
  if (f) {
    const extras = [];
    if (f.ebitda) extras.push(`EBITDA: $${f.ebitda.toLocaleString()}`);
    if (f.rent) extras.push(`Rent: $${f.rent.toLocaleString()}`);
    if (f.employees) extras.push(`Employees: ${f.employees}`);
    if (f.established) extras.push(`Established: ${f.established}`);
    if (f.sqft) extras.push(`Square footage: ${f.sqft.toLocaleString()}`);
    if (extras.length > 0) parts.push(extras.join("\n"));
  }

  if (listing.fullDescription) {
    parts.push(`\nFull listing description:\n${listing.fullDescription}`);
  }

  return parts.join("\n");
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function deepAnalyzeListing(listing, retries = 3) {
  // prefer financials scraped from the full listing page over email-parsed ones
  const askingPrice = listing.asking_price || listing.pageFinancials?.askingPrice || null;
  const annualCashFlow =
    listing.sde ||
    listing.cash_flow ||
    listing.pageFinancials?.sde ||
    listing.pageFinancials?.cashFlow ||
    null;

  const sba = computeSbaTerms(askingPrice);
  const dscr = sba ? computeDscr(annualCashFlow, sba.annualDebtService) : null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await client.messages.create({
        model: "claude-sonnet-5",
        max_tokens: 2000,
        thinking: { type: "disabled" },
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content:
              buildAnalysisPrompt(listing, sba, dscr) +
              "\n\nListing:\n" +
              formatListingForAnalysis(listing),
          },
        ],
      });

      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");

      const cleaned = text.replace(/```json\n?|```\n?/g, "").trim();
      const analysis = JSON.parse(cleaned);

      // code-computed figures are authoritative over model output
      return Object.assign({}, analysis, {
        sba_down_payment: sba ? sba.downPayment : null,
        sba_monthly_payment: sba ? sba.monthlyPayment : null,
        dscr: dscr,
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

      console.error(`    Deep analysis failed (attempt ${attempt}): ${(err.message || "").substring(0, 80)}`);

      if (attempt === retries) {
        return {
          sba_down_payment: sba ? sba.downPayment : null,
          sba_monthly_payment: sba ? sba.monthlyPayment : null,
          dscr: dscr,
          go_no_go: null,
          deal_summary: `Deep analysis failed after ${retries} attempts`,
        };
      }
    }
  }
}

async function deepAnalyzeListings(listings) {
  const results = [];
  for (let i = 0; i < listings.length; i++) {
    const listing = listings[i];
    console.log(`  Analyzing [${i + 1}/${listings.length}]: ${listing.title || "unknown"}`);
    const analysis = await deepAnalyzeListing(listing);
    results.push(Object.assign({}, listing, analysis));
    if (i < listings.length - 1) {
      await sleep(3000);
    }
  }
  return results;
}

module.exports = { deepAnalyzeListings, deepAnalyzeListing, computeSbaTerms, computeDscr };
