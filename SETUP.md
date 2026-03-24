# boring business scanner

automated pipeline that scrapes your email for business-for-sale alerts, scores them with ai, and writes the results to a google sheet. runs on a schedule via github actions.

---

## how it works

```
saved search alerts (bizbuysell, bizquest, etc.)
  → gmail inbox
    → parser extracts listings
      → claude scores each on absentee / hands-off / optimization / durability
        → google sheets (deduped, sorted by score)
```

---

## setup (one-time, ~15 minutes)

### step 1: set up saved searches on listing sites

go to each of these sites and create a free account with saved search alerts:

**bizbuysell.com** (largest, best data)
- search → service businesses → your state(s)
- filter: cash flow $100k+, asking price under $750k
- save search → enable email alerts (daily digest)

**bizquest.com**
- similar filters, enable alerts

**businessbroker.net**
- similar filters, enable alerts

**dealstream.com** (optional, more middle-market)
- enable alerts for service businesses

make sure all alerts go to the gmail address you'll use for this tool.

### step 2: google cloud project

1. go to [console.cloud.google.com](https://console.cloud.google.com)
2. create a new project called `boring-biz-scanner`
3. enable these apis:
   - gmail api
   - google sheets api
4. go to **credentials** → **create credentials** → **oauth 2.0 client id**
5. application type: **web application**
6. add authorized redirect uri: `http://localhost:3000/oauth/callback`
7. copy the **client id** and **client secret**

### step 3: create your google sheet

1. create a new google sheet
2. name it whatever you want
3. copy the spreadsheet id from the url:
   `https://docs.google.com/spreadsheets/d/THIS_PART_IS_THE_ID/edit`

### step 4: configure environment

```bash
cp .env.example .env
```

fill in:
- `170534391997-rfg4crhqmufb0qknojd8aq8nbvv89q2n.apps.googleusercontent.com` — from step 2
- `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` — from step 2
- `1b7mQj3e_ItTsQ0P3OaaAW3PyY8qSlQl5uojAmYcqd6k` — from step 3
- `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` — from [console.anthropic.com](https://console.anthropic.com)

### step 5: get your oauth refresh token

```bash
node setup-oauth.js
```

this opens a browser window, you authorize the app, and it prints your refresh token. paste it into `.env` as `GOOGLE_REFRESH_TOKEN`.

### step 6: test it

```bash
node run.js 30
```

(scans last 30 days of emails — use a bigger number for your first run to catch anything already in your inbox)

---

## running it

### manually

```bash
node run.js        # last 7 days (default)
node run.js 14     # last 14 days
```

### automated via github actions

1. push this repo to github (private repo)
2. go to **settings** → **secrets and variables** → **actions**
3. add these repository secrets:
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `GOOGLE_REFRESH_TOKEN`
   - `SPREADSHEET_ID`
   - `ANTHROPIC_API_KEY`
4. the workflow runs automatically every monday and thursday at 9am pacific
5. you can also trigger it manually from the actions tab

---

## what the sheet looks like

| score | title | type | asking price | sde | location | absentee | hands-off | optimization | notes |
|-------|-------|------|-------------|-----|----------|----------|-----------|-------------|-------|
| 8.5 | coin laundry - 30 machines | laundromat | $285,000 | $142,000 | Renton, WA | 9 | 9 | 7 | strong absentee play, below-market pricing on machines... |
| 7.2 | self-serve car wash 4-bay | car wash | $450,000 | $165,000 | Tacoma, WA | 8 | 7 | 8 | automated, needs marketing optimization... |
| 4.1 | dry cleaning w/ alterations | dry cleaner | $320,000 | $110,000 | Bellevue, WA | 4 | 3 | 6 | requires skilled staff, owner works counter... |

---

## scoring rubric

each listing gets scored 0-10 on four dimensions:

- **absentee** (30% weight): can this run without you? coin-op / automated = high
- **hands-off** (25%): how little management is needed? fewer employees = higher
- **optimization** (20%): is there obvious upside? outdated ops = high potential
- **durability** (15%): recession-resistant? essential services = high
- **financial fit** (10%): meets sde minimum? within driving distance?

---

## customizing

edit the scoring criteria in `src/scorer.js` — the `SCORING_PROMPT` constant. you can change the weights, add your own criteria, or adjust the preferred region.

edit the category keywords in `src/parser.js` — the `extractCategory` function — if you want to add or remove business types.

---

## costs

- **gmail api**: free
- **sheets api**: free
- **claude api**: ~$0.01-0.03 per listing scored (sonnet). a typical weekly run with 20-50 listings costs about $0.50-1.50
- **github actions**: free for private repos (2,000 minutes/month)

---

## what this doesn't do (yet)

- **scrape listing sites directly** — uses email alerts instead (more reliable, no tos issues)
- **off-market prospecting** — that's phase 2 (google maps api + secretary of state data)
- **auto-contact brokers** — you still review and reach out manually

---

## troubleshooting

**no emails found**: make sure your saved search alerts are actually sending emails. check spam. run with a larger day window.

**parsing errors**: the email formats change occasionally. run with `DEBUG=1 node run.js` to see raw email content. the parser will fall back to ai extraction for unrecognized formats.

**sheets permission error**: make sure the google account you authorized has edit access to the spreadsheet.
