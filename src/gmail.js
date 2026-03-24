const { google } = require("googleapis");

const LISTING_SENDERS = [
  { domain: "bizbuysell.com", name: "BizBuySell" },
  { domain: "bizquest.com", name: "BizQuest" },
  { domain: "businessbroker.net", name: "BusinessBroker.net" },
  { domain: "dealstream.com", name: "DealStream" },
  { domain: "loopnet.com", name: "LoopNet" },
];

function getAuthClient() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    "http://localhost:3000/oauth/callback"
  );
  oauth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
  });
  return oauth2Client;
}

async function fetchListingEmails(auth, daysBack = 7) {
  const gmail = google.gmail({ version: "v1", auth });

  // build query: from any listing site, within date range
  const fromQueries = LISTING_SENDERS.map(
    (s) => `from:${s.domain}`
  ).join(" OR ");
  const after = new Date();
  after.setDate(after.getDate() - daysBack);
  const afterStr = `${after.getFullYear()}/${after.getMonth() + 1}/${after.getDate()}`;

  const query = `(${fromQueries}) after:${afterStr}`;

  console.log(`  Gmail query: ${query}`);

  const res = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults: 100,
  });

  if (!res.data.messages || res.data.messages.length === 0) {
    console.log("  No listing emails found.");
    return [];
  }

  console.log(`  Found ${res.data.messages.length} emails`);

  const emails = [];
  for (const msg of res.data.messages) {
    const full = await gmail.users.messages.get({
      userId: "me",
      id: msg.id,
      format: "full",
    });

    const headers = full.data.payload.headers;
    const from = headers.find((h) => h.name === "From")?.value || "";
    const subject = headers.find((h) => h.name === "Subject")?.value || "";
    const date = headers.find((h) => h.name === "Date")?.value || "";

    // extract body (handle multipart)
    let body = "";
    if (full.data.payload.parts) {
      for (const part of full.data.payload.parts) {
        if (part.mimeType === "text/html" && part.body?.data) {
          body = Buffer.from(part.body.data, "base64").toString("utf-8");
          break;
        }
        if (part.mimeType === "text/plain" && part.body?.data && !body) {
          body = Buffer.from(part.body.data, "base64").toString("utf-8");
        }
      }
    } else if (full.data.payload.body?.data) {
      body = Buffer.from(full.data.payload.body.data, "base64").toString(
        "utf-8"
      );
    }

    const source =
      LISTING_SENDERS.find((s) => from.includes(s.domain))?.name || "Unknown";

    emails.push({
      id: msg.id,
      from,
      subject,
      date,
      source,
      htmlBody: body,
    });
  }

  return emails;
}

module.exports = { getAuthClient, fetchListingEmails, LISTING_SENDERS };
