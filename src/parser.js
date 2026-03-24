const cheerio = require("cheerio");

function parseListingEmail(email) {
  const $ = cheerio.load(email.htmlBody || "");

  // CRITICAL: remove style, script, and head tags BEFORE extracting text
  $("style").remove();
  $("script").remove();
  $("head").remove();
  $("meta").remove();
  $("link").remove();
  $("noscript").remove();

  // extract listing URLs
  const urls = [];
  $("a").each((_, el) => {
    const href = $(el).attr("href") || "";
    if (isListingUrl(href)) {
      urls.push(cleanUrl(href));
    }
  });

  // replace images with alt text
  $("img").each((_, el) => {
    const alt = $(el).attr("alt");
    if (alt) $(el).replaceWith(alt);
    else $(el).remove();
  });

  // get clean text
  let text = ($("body").text() || $.text())
    .replace(/[\t ]+/g, " ")
    .replace(/\n\s*\n/g, "\n")
    .split("\n")
    .map(line => line.trim())
    .filter(line => {
      if (line.length < 3) return false;
      if (/^[{}.#@]/.test(line)) return false;
      if (/^\s*(margin|padding|font|color|background|border|width|height|display|text-align)/i.test(line)) return false;
      if (/^\s*(mso-|webkit-|-ms-)/i.test(line)) return false;
      if (/^(if|endif|\[if)/i.test(line)) return false;
      if (/^\s*\/\*/.test(line)) return false;
      if (/ReadMsgBody|ExternalClass/.test(line)) return false;
      return true;
    })
    .join("\n")
    .trim();

  // extract info from subject line
  const subjectInfo = parseSubject(email.subject);

  // cap text length
  if (text.length > 2000) {
    text = text.substring(0, 2000);
  }

  if (text.length < 30 && !subjectInfo.title) {
    return [];
  }

  return [{
    source: email.source,
    emailDate: email.date,
    title: subjectInfo.title || null,
    location: subjectInfo.location || null,
    category: subjectInfo.category || null,
    url: urls.length > 0 ? urls[0] : null,
    rawText: "Subject: " + email.subject + "\n\n" + text,
    needsAiExtraction: true,
  }];
}

function parseSubject(subject) {
  const result = { title: null, location: null, category: null };
  if (!subject) return result;

  const singleMatch = subject.match(/Business for Sale:\s*(.+?)\s+in\s+(.+)/i);
  if (singleMatch) {
    result.title = singleMatch[1].trim();
    result.location = singleMatch[2].trim();
    result.category = detectCategory(result.title);
    return result;
  }

  const digestMatch = subject.match(/(\d+)\s+New Business Matches/i);
  if (digestMatch) {
    result.title = "Digest: " + digestMatch[1] + " new listings";
    return result;
  }

  result.title = subject;
  return result;
}

function detectCategory(text) {
  const categories = {
    laundromat: ["laundromat", "laundry", "coin laundry"],
    "dry cleaner": ["dry clean"],
    "car wash": ["car wash", "auto wash"],
    "self-storage": ["self-storage", "storage facility"],
    vending: ["vending"],
    "gas station": ["gas station"],
    "convenience store": ["convenience store"],
    restaurant: ["restaurant", "food", "pizza", "sushi", "chinese", "bakery", "coffee", "cafe"],
    bar: ["bar", "pub", "tavern"],
    "cleaning service": ["cleaning business", "cleaning service", "janitorial"],
    gym: ["gym", "fitness center"],
    salon: ["salon", "barber", "nail salon", "hair"],
    "auto repair": ["auto repair", "auto service"],
    construction: ["construction", "contracting"],
    trucking: ["trucking"],
    "grocery store": ["grocery", "supermarket"],
    retail: ["retail"],
    ecommerce: ["ecommerce", "websites"],
    spa: ["spa", "massage"],
    medical: ["medical", "pharmacy"],
    insurance: ["insurance"],
    transportation: ["limo", "transportation"],
  };

  const lower = text.toLowerCase();
  for (const [cat, keywords] of Object.entries(categories)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) return cat;
    }
  }
  return null;
}

function isListingUrl(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  return (
    lower.includes("bizbuysell.com/listing") ||
    (lower.includes("bizbuysell.com") && lower.includes("profile")) ||
    lower.includes("bizquest.com/business") ||
    lower.includes("businessbroker.net/listing") ||
    lower.includes("businessbroker.net/business") ||
    lower.includes("dealstream.com/listing")
  );
}

function cleanUrl(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname + (u.search ? "?" + u.searchParams.toString() : "");
  } catch {
    return url;
  }
}

module.exports = { parseListingEmail };
