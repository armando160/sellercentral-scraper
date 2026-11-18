# Amazon review scraper (Seller Central to Google Sheets)

Every Monday at 6:00am this Mac wakes up, opens Chrome, goes to the
Seller Central **Customer Reviews** page, clicks through every page, and
saves the reviews. New and changed reviews go to a **Google Sheet** with
"Monthly" and "By product" tabs. Then you get a summary.

## How it works

| Question | Answer |
|---|---|
| Where does it run? | On this Mac, in real Google Chrome, with its own saved Chrome profile |
| How does it sign in? | **It doesn't.** You sign in by hand (`npm run login`). The session is saved and reused until Amazon signs it out |
| How does it get the reviews? | It opens the reviews page and **clicks › like a person** (4 to 9 seconds per page). Each click makes the page load 50 reviews from Amazon. The script reads that data as it arrives. It never calls Amazon by itself |
| How many pages? | All of them, up to 20 (the page's limit). About 2 to 3 minutes |
| What does it save? | Review ID, date, stars, title, text, parent ASIN, child ASIN, product name, verified, Vine, images, video, replied, done. **Not** the reviewer's name |
| Where? | `data/reviews.db` on this Mac, and the Google Sheet |
| Duplicates? | Never. Each review is saved once by its Amazon review ID. If a review changes (for example it gets marked replied), the row is updated |
| How often? | Weekly, Monday 6:00am |

### What the reviews page allows (checked 18 Nov 2026)

- It only shows reviews from the **last 90 days** (about 1,050 right now, roughly 350 a month).
- It shows at most **1,000** (20 pages x 50). Right now that reaches back to 23 Aug.
- Because of this, run it **at least every 2 months** or reviews fall off the page
  before they're saved. Weekly is plenty.
- History starts **23 Aug 2026**. August 2026 is a partial month.

## Setup (once)

Needs a Mac with Google Chrome and Node 22.13 or newer (`node --version`).
Open Terminal, get the code, and go into the folder:

```bash
git clone <this repo's URL>
```

```bash
cd amazon-review-scraper
```

### Step 1: Install

```bash
npm install
```

### Step 2: Sign in

```bash
npm run login
```

A Chrome window opens. Sign in to Seller Central. Tick **"Keep me signed in"**
and **"Don't require OTP on this browser"** if Amazon offers them. Wait for the
reviews list. Press Enter in Terminal.

### Step 3: Connect the Google Sheet

**If the sheet already exists** (someone set it up before you): ask its owner
for the web app URL and token, then run `./setup-sheets.sh url` and save the
token with `security add-generic-password -U -s amazon-review-scraper -a sheets-token -w`
(it asks for the value). Skip to Step 4.

**New sheet:**

1. Make a new Google Sheet (e.g. "Amazon reviews"). Share it with whoever needs it.
2. In the sheet: **Extensions > Apps Script**.
3. Delete what's there. Paste everything from `apps-script/Code.gs`.
4. In Terminal, make the secret token:
   ```bash
   ./setup-sheets.sh token
   ```
5. Copy the token it shows. In Apps Script, replace `PASTE-TOKEN-HERE` with it. Save.
6. **Deploy > New deployment > type: Web app.**
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Click Deploy. Allow access when Google asks.
7. Copy the **Web app URL** (ends in `/exec`). In Terminal:
   ```bash
   ./setup-sheets.sh url
   ```
   Paste the URL.

"Anyone" means anyone with the URL **and** the token can add rows. Nobody can
read the sheet through it. Keep the URL and token private.

### Step 4: First pull

```bash
npm run pull
```

Check the sheet: a **Reviews** tab with about 1,000 rows, plus **Monthly** and
**By product** tabs.

### Step 5: Weekly schedule

```bash
./install-schedule.sh
```

Then make the Mac wake itself on Mondays (asks for your Mac password):

```bash
sudo pmset repeat wakeorpoweron M 05:55:00
```

Leave the Mac **plugged in with the lid open**. It can sleep; it will wake.

### Step 6 (optional): Alerts on your phone

Mac notifications only help if you're at the Mac.

- **Telegram** (Sunday reminder, Monday summary, failures):
  ```bash
  ./setup-sheets.sh telegram
  ```
- **Healthchecks.io** (free; emails you if the Monday run **never happened**,
  e.g. the Mac was dead). Make a check: period 1 week, grace 3 hours. Then:
  ```bash
  ./setup-sheets.sh healthcheck
  ```

## What you'll get each week

| When | What |
|---|---|
| Sunday 6:00pm | "All good: plugged in, signed in." or "Fix tonight: NOT plugged in (battery 34%). Seller Central signed out: run npm run login." |
| Monday ~6:05am | "97 new reviews (6 are 1-2 star). 214 so far this month." or what went wrong |
| Monday ~9:00am | Healthchecks email, **only** if the run never reported in (optional) |

## When Amazon signs you out

You'll see it in the Sunday reminder or the Monday message. Then:

```bash
npm run login
```

```bash
npm run pull
```

## Commands

| Command | What it does |
|---|---|
| `npm run pull` | Pull now (and upload to the sheet) |
| `npm run login` | Sign in by hand |
| `npm run stats` | Reviews per month and star, missing fields, last runs |
| `npm run remind` | Run the Sunday check now |
| `npm run monthly` | CSV of reviews per month per parent ASIN |
| `npm run export` | CSV of every review |
| `./install-schedule.sh remove` | Turn off the schedule (`sudo pmset repeat cancel` for the wake) |

## If something goes wrong

| Message | What to do |
|---|---|
| `Signed out` | `npm run login`, then `npm run pull` |
| `Reviews didn't load` / `Page N didn't load` | Amazon may have changed the page. A screenshot is in `logs/` |
| `Sheets replied with non-JSON` | Web app URL wrong, or access isn't "Anyone". Redo Step 3.6 to 3.7 |
| `Sheets refused: bad token` | Token in Code.gs doesn't match. Redo Step 3.4 to 3.5, then **Deploy > Manage deployments > edit > New version** |
| Nothing happened Monday | Mac was off or unplugged. `pmset -g sched` should list the Monday wake. Run `npm run pull` |

A failed upload is retried on the next run: reviews stay marked "not yet in Sheets" until they're sent.

## Rules

| Do | Don't |
|---|---|
| Run it from this Mac, on your normal internet | Run it from a cloud server or a VPN |
| Keep it weekly | Run it many times a day |
| Sign in by hand when asked | Put your password or OTP anywhere in this folder |
| Keep `.browser-profile/` on this Mac | Share or copy `.browser-profile/` (it's a signed-in session) |

## Files

| File | What it does |
|---|---|
| `scrape.js` | The pull |
| `login.js` | Opens Chrome so you sign in |
| `remind.js` | Sunday check: power and sign-in |
| `lib/bcr.js` | What the reviews data looks like and which fields are saved |
| `lib/browser.js` | Opens Chrome, finds and clicks ›, listens to the page's data |
| `lib/db.js` | Database tables: `reviews`, `raw_responses` (untouched data), `runs` |
| `lib/sheets.js` | Sends new and changed reviews to the sheet |
| `apps-script/Code.gs` | Goes in the Google Sheet (Extensions > Apps Script) |
| `lib/notify.js` | Mac notification, Telegram, Healthchecks |
| `setup-sheets.sh` | Saves the sheet URL, token and alerts in the Mac Keychain |
| `install-schedule.sh` | Monday pull and Sunday reminder |
| `test/` | Tests and a fake reviews page (`npm test`) |

## Matching with other sources

`Review ID` is Amazon's own ID. Sellerlabs and Swapt use the same IDs, so you
can match on it to see exactly which reviews Sellerlabs misses.
