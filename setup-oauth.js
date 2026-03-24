/**
 * One-time setup script to get a Google OAuth2 refresh token.
 * Run this once: node setup-oauth.js
 * Then paste the refresh token into your .env file.
 */

require("dotenv").config();

const { google } = require("googleapis");
const http = require("http");
const url = require("url");

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/spreadsheets",
];

async function main() {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║  Google Cloud Setup Required                                 ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  1. Go to: https://console.cloud.google.com                 ║
║  2. Create a new project (or select existing)                ║
║  3. Enable these APIs:                                       ║
║     - Gmail API                                              ║
║     - Google Sheets API                                      ║
║  4. Go to Credentials → Create Credentials → OAuth Client    ║
║  5. Application type: "Web application"                      ║
║  6. Add redirect URI: http://localhost:3000/oauth/callback   ║
║  7. Copy Client ID and Client Secret to your .env file       ║
║  8. Run this script again                                    ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
    `);
    return;
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    "http://localhost:3000/oauth/callback"
  );

  const authorizeUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent", // force refresh token
  });

  console.log(`\n🔗 Open this URL in your browser:\n`);
  console.log(`  ${authorizeUrl}\n`);
  console.log(`Waiting for callback...\n`);

  // start a temporary server to catch the callback
  const server = http.createServer(async (req, res) => {
    const qs = url.parse(req.url, true).query;
    if (qs.code) {
      try {
        const { tokens } = await oauth2Client.getToken(qs.code);

        res.end(`
          <html><body style="font-family: monospace; padding: 40px; background: #111; color: #eee;">
            <h2>✅ Authorization successful!</h2>
            <p>You can close this tab and return to the terminal.</p>
          </body></html>
        `);

        console.log(`✅ Got tokens!\n`);
        console.log(`Add this to your .env file:\n`);
        console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`);

        server.close();
        process.exit(0);
      } catch (err) {
        res.end("Error: " + err.message);
        console.error("Token exchange failed:", err.message);
        server.close();
        process.exit(1);
      }
    }
  });

  server.listen(3000, () => {
    console.log("  (Listening on http://localhost:3000)");
  });
}

main();
