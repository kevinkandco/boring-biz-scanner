// Google Places API (New) text search — finds operating businesses by category
// and region for off-market acquisition sourcing.

const PLACES_URL = "https://places.googleapis.com/v1/places:searchText";

const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.rating",
  "places.userRatingCount",
  "places.websiteUri",
  "places.nationalPhoneNumber",
  "places.businessStatus",
  "places.googleMapsUri",
  "places.primaryTypeDisplayName",
  "nextPageToken",
].join(",");

function normalizePlace(place, category) {
  return {
    placeId: place.id,
    name: place.displayName?.text || "",
    category,
    primaryType: place.primaryTypeDisplayName?.text || null,
    address: place.formattedAddress || "",
    rating: place.rating ?? null,
    reviewCount: place.userRatingCount ?? null,
    website: place.websiteUri || null,
    phone: place.nationalPhoneNumber || null,
    mapsUrl: place.googleMapsUri || null,
    businessStatus: place.businessStatus || null,
  };
}

async function searchCategory(category, region, { maxResults = 20 } = {}) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_PLACES_API_KEY is not set");

  const results = [];
  let pageToken = null;

  while (results.length < maxResults) {
    const body = {
      textQuery: `${category} in ${region}`,
      pageSize: Math.min(20, maxResults - results.length),
    };
    if (pageToken) body.pageToken = pageToken;

    const res = await fetch(PLACES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });

    if (!res.ok) {
      const errText = (await res.text()).substring(0, 200);
      throw new Error(`Places API ${res.status}: ${errText}`);
    }

    const data = await res.json();
    const places = data.places || [];
    for (const p of places) {
      const t = normalizePlace(p, category);
      // skip closed businesses; keep OPERATIONAL and unknown-status entries
      if (t.businessStatus && t.businessStatus !== "OPERATIONAL") continue;
      results.push(t);
    }

    pageToken = data.nextPageToken || null;
    if (!pageToken || places.length === 0) break;
  }

  return results;
}

async function searchTargets(categories, region, opts = {}) {
  const all = [];
  const seen = new Set();

  for (const category of categories) {
    console.log(`  Searching: "${category}" in ${region}...`);
    try {
      const targets = await searchCategory(category, region, opts);
      let added = 0;
      for (const t of targets) {
        if (seen.has(t.placeId)) continue;
        seen.add(t.placeId);
        t.region = region;
        all.push(t);
        added++;
      }
      console.log(`    ${added} businesses found`);
    } catch (err) {
      console.error(`    Search failed: ${(err.message || "").substring(0, 120)}`);
    }
  }

  return all;
}

module.exports = { searchTargets, searchCategory, normalizePlace };
