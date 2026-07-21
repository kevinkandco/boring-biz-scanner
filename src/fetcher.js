const cheerio = require("cheerio");

const FETCH_TIMEOUT_MS = 20000;

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

function parseMoney(str) {
  if (!str) return null;
  const n = parseInt(str.replace(/[,$]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

function extractFinancials(text) {
  const patterns = {
    askingPrice: /asking price:?\s*\$\s*([\d,]+)/i,
    cashFlow: /cash flow(?:\s*\(sde\))?:?\s*\$\s*([\d,]+)/i,
    sde: /(?:seller'?s? discretionary earnings|SDE):?\s*\$\s*([\d,]+)/i,
    revenue: /(?:gross revenue|gross income|annual revenue|revenue):?\s*\$\s*([\d,]+)/i,
    ebitda: /EBITDA:?\s*\$\s*([\d,]+)/i,
    rent: /rent:?\s*\$\s*([\d,]+)/i,
  };

  const financials = {};
  for (const [key, re] of Object.entries(patterns)) {
    const m = text.match(re);
    financials[key] = m ? parseMoney(m[1]) : null;
  }

  const employees = text.match(/employees:?\s*([\d,]+)/i);
  financials.employees = employees ? parseMoney(employees[1]) : null;

  const established = text.match(/established:?\s*((?:19|20)\d{2})/i);
  financials.established = established ? parseInt(established[1], 10) : null;

  const sqft = text.match(
    /(?:building s\.?f\.?|square footage|sq\.?\s*ft\.?):?\s*([\d,]+)/i
  );
  financials.sqft = sqft ? parseMoney(sqft[1]) : null;

  return financials;
}

async function fetchListingPage(url) {
  if (!url) return null;

  let html;
  try {
    const res = await fetch(url, {
      headers: BROWSER_HEADERS,
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.log(`    Fetch failed (${res.status}) for ${url}`);
      return null;
    }
    html = await res.text();
  } catch (err) {
    console.log(`    Fetch error for ${url}: ${(err.message || "").substring(0, 80)}`);
    return null;
  }

  const $ = cheerio.load(html);
  $("script, style, head, meta, link, noscript, iframe, svg, nav, footer, header").remove();

  const text = ($("body").text() || $.text())
    .replace(/[\t ]+/g, " ")
    .replace(/\n\s*\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length >= 3)
    .join("\n")
    .trim();

  if (text.length < 100) return null;

  return {
    fullDescription: text.substring(0, 4000),
    financials: extractFinancials(text),
  };
}

module.exports = { fetchListingPage, extractFinancials };
