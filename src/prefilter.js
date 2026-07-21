// Deterministic pre-filter for off-market targets — drops obvious non-fits
// before any LLM scoring. Free and instant; typically removes 30-50% of
// raw Places results (franchises, too-small shops, troubled businesses).

const FRANCHISE_PATTERNS = [
  /mr\.?\s?(rooter|electric|handyman|appliance|sparky)/i,
  /roto.?rooter/i,
  /jiffy lube/i,
  /midas/i,
  /meineke/i,
  /aamco/i,
  /firestone/i,
  /les schwab/i,
  /grease monkey/i,
  /valvoline/i,
  /christian brothers automotive/i,
  /one hour (heating|air)/i,
  /benjamin franklin plumbing/i,
  /service ?master/i,
  /servpro/i,
  /merry maids/i,
  /molly maid/i,
  /jan-?pro/i,
  /vanguard cleaning/i,
  /coverall/i,
  /stanley steemer/i,
  /stratus building/i,
  /anago/i,
  /oxi ?fresh/i,
  /chem-?dry/i,
  /precision (tune|door)/i,
  /big o tires/i,
  /discount tire/i,
  /america'?s tire/i,
  /monro/i,
  /take 5/i,
  /terminix/i,
  /orkin/i,
  /aire serv/i,
  /rooter-?man/i,
  /puroclean/i,
  /paul davis/i,
  /window genie/i,
  /city wide facility/i,
  /pep boys/i,
  /caliber collision/i,
  /maaco/i,
  /gerber collision/i,
  /horizon services/i,
  /apex service partners/i,
];

const MIN_REVIEWS = parseInt(process.env.PREFILTER_MIN_REVIEWS || "15", 10);
const MIN_RATING = parseFloat(process.env.PREFILTER_MIN_RATING || "3.8");

function prefilterTargets(targets) {
  const kept = [];
  const dropped = [];

  for (const t of targets) {
    const franchise = FRANCHISE_PATTERNS.find((re) => re.test(t.name));
    if (franchise) {
      dropped.push({ target: t, reason: "franchise/chain" });
      continue;
    }
    if (t.reviewCount != null && t.reviewCount < MIN_REVIEWS) {
      dropped.push({ target: t, reason: `too small (<${MIN_REVIEWS} reviews)` });
      continue;
    }
    if (t.rating != null && t.rating < MIN_RATING) {
      dropped.push({ target: t, reason: `weak rating (<${MIN_RATING})` });
      continue;
    }
    kept.push(t);
  }

  return { kept, dropped };
}

function summarizeDropped(dropped) {
  const counts = {};
  for (const d of dropped) counts[d.reason] = (counts[d.reason] || 0) + 1;
  return Object.entries(counts)
    .map(([reason, n]) => `${n} ${reason}`)
    .join(", ");
}

module.exports = { prefilterTargets, summarizeDropped };
