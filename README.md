# Amazon reviews and ratings: Seller Central + Vendor Central

Two pulls run on this Mac, in real Chrome, clicking like a person:

| Pull | When | What it saves |
|---|---|---|
| **Seller Central** written reviews | Monday and Tuesday 6:00am | Every written review (text, stars, ASINs) per store and marketplace. Uploads to a Google Sheet, then one email |
| **Vendor Central** dashboard | Every day 6:00am | Review count (written + star-only), star rating and shipped units per ASIN, with Amazon's refresh dates. Quiet unless there's a problem |

Everything goes into one database on this Mac, `data/reviews.db`. That's the
real product; the Google Sheet is temporary.

**Signed out?** Double-click **"Amazon Sign In"** on the Desktop. Chrome opens
only for the site that's signed out; you type the password and code; the window
closes by itself, and a pull that failed today runs again.

## What it pulls

Set in `views.json`. A **view** = one store + one marketplace in the Seller
Central top bar.

| Day | Store | Brand in the sheet | Marketplaces |
|---|---|---|---|
| Monday | LIFEPRO OUTLET | Lifepro | US, CA, MX |
| Tuesday | Joyberri LLC | Joyberri | US, CA, MX |
| Tuesday | Sunello | Sunello | US, CA, MX |

Europe, UAE and Saudi Arabia for Lifepro are in `views.json` but turned off
(`"enabled": false`): they live on other Seller Central sites
(sellercentral.amazon.co.uk...) that need their own sign-in. Not built yet.

If a store doesn't sell in a marketplace, that view is skipped and the email
says so.

## How it works

| Question | Answer |
|---|---|
| Where does it run? | On this Mac, in real Google Chrome, with its own saved Chrome profile |
| How does it sign in? | **It doesn't.** You sign in by hand (`npm run login`). The session is saved and reused until Amazon signs it out |
| How does it get the reviews? | It opens the reviews page and **clicks › like a person** (4 to 9 seconds per page). Each click makes the page load 50 reviews from Amazon. The script reads that data as it arrives. It never calls Amazon by itself |
| How does it switch store / marketplace? | It clicks the top-bar selector like a person, checks the top bar shows the right one, then reads the pages. At the end it switches back to **LIFEPRO OUTLET / United States**. Switching changes it in your open Seller Central tabs too, which is why it runs at 6am |
| How many pages? | All of them, up to 20 per view (the page's limit). About 3 minutes for Lifepro US, under a minute for small views |
| What does it save? | Review ID, date, brand, marketplace, stars, title, text, parent ASIN, child ASIN, product name, verified, Vine, images, video, replied, done. **Not** the reviewer's name |
| Where? | `data/reviews.db` on this Mac, and the Google Sheet |
| Duplicates? | Never. Each review is saved once by its Amazon review ID. If a review changes (for example it gets marked replied), the row is updated |
| How often? | Weekly. Lifepro Monday 6:00am, Joyberri and Sunello Tuesday 6:00am |

### What the reviews page allows (checked 18 Nov 2026)

- It only shows reviews from the **last 90 days** (Lifepro US about 1,050 right now, roughly 350 a month;
  Lifepro CA 88, Joyberri US 65, Sunello US 1).
- It shows at most **1,000** per view (20 pages x 50). Right now that reaches back to 23 Aug for Lifepro US.
- Because of this, run it **at least every 2 months** or reviews fall off the page
  before they're saved. Weekly is plenty.
- History starts **23 Aug 2026** for Lifepro US, and from the first run for the other views.

## Vendor Central (daily)

Details and the reasons behind them: `PLAN-vendor-central.md`.

| Question | Answer |
|---|---|
| Which page? | Your Custom Analytics dashboard "Armando Review & Rating View" (link in `lib/config.js`, `vcUrl`) |
| What does it do? | Opens it, waits for the table, keeps the table data the page itself loaded (it has each column's refresh date), clicks **Export** once and keeps Amazon's file too. Both saved untouched in `data/vc/`. Checks they match |
| What's saved? | `vc_pulls` (one per run: dates, time period, files), `vc_rows` (one per ASIN), `vc_column_dates` (each column's "Last refreshed on") |
| Review count | Amazon's shared count for the product **family** (all colors/sizes show the same number): never add children up. Written + star-only ratings, all marketplaces that feed the listing |
| Star rating | 2 decimals. Amazon rounds it before it reaches the page |
| Same data twice? | If the ratings refresh date didn't change, the run is kept and marked as a repeat (`repeat_of`) |
| Time period | Must be "Month to date". If it isn't, counts are still saved and you get an email explaining how to fix it |
| Emails | Only when something needs you: signed out, table didn't load, a column is missing, time period changed. Each says what happened, why it matters, what to do |
| Runs with Seller Central? | Never at the same moment. Both take a lock; on Monday and Tuesday Vendor Central waits for the review pull to finish |

`npm run status` shows the newest day of each kind of data, and up to which day
star-only ratings can be worked out (both sources needed). The same table is at
the bottom of the Monday and Tuesday emails.

## The Google Sheet

One sheet for all brands and marketplaces.

| Tab | What's in it |
|---|---|
| **Monthly** | The one to read. Months run left to right (oldest to newest, last 12, then a total). 3 tables: (1) all brands and marketplaces: reviews, 1-2 star, %, average and each star count, with a chart under it; (2) Lifepro, with a row per marketplace; (3) **Explore**: pick a Brand and a Marketplace in the yellow boxes and the table changes. Updates by itself |
| **Reviews** | Every review, one row each. Brand and Marketplace columns, Category and Issue at the end (filled by hand or by Claude, kept by Review ID), stars colored (1-2 red, 3 yellow, 4-5 green), filters on, links go to the right Amazon site |
| **By product** | One row per parent ASIN + brand + marketplace: reviews in each of the last 12 months (left to right), then all reviews, last 30 days, average stars, 1-2 star count and %. Rebuilt after every upload |

## Setup (once)

Needs a Mac with Google Chrome and Node 22.13 or newer (`node --version`).
Open Terminal, get the code, and go into the folder:

```bash
git clone <this repo's URL>
```

```bash
cd sellercentral-scraper
```

### Step 1: Install

```bash
npm install
```

### Step 2: Sign in

```bash
npm run signin
```

(Same as double-clicking "Amazon Sign In" on the Desktop.) Chrome opens for
Seller Central, then Vendor Central. Sign in to each. Tick **"Keep me signed in"**
and **"Don't require OTP on this browser"** if Amazon offers them. Each window
closes by itself once you're in.

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

This pulls today's views. To pull a given day's views or one view:

```bash
npm run pull -- --day=tuesday
```

```bash
npm run pull -- --view="Joyberri LLC/US"
```

Check the sheet: a **Reviews** tab, plus **Monthly** and **By product** tabs.

### Step 5: Weekly schedule

```bash
./install-schedule.sh
```

Then make the Mac wake itself every morning (asks for your Mac password):

```bash
sudo pmset repeat wakeorpoweron MTWRFSU 05:55:00
```

Leave the Mac **plugged in with the lid open**. It can sleep; it will wake.

### Step 6: Email alerts

The Apps Script sends the status emails to `EMAIL_TO` (top of `Code.gs`).
After pasting or updating `Code.gs`:

1. In the Apps Script editor, pick **setup** in the function menu (top bar)
   and click **Run**. Allow the permissions. It builds the tabs and turns on
   the missed-run check. You get a "missed-run check is on" email.
2. **Deploy > Manage deployments > pencil > Version: New version > Deploy.**
   The URL stays the same.

| Email | When |
|---|---|
| "Monday pull at 6:00am, all good" or "FIX TONIGHT" | Sunday 6pm (and Monday 6pm for Tuesday), from the Mac |
| "Monday: 97 new (6 low-star)": a line per view, then the new 1-2 star reviews by view | Monday ~6:10am (Tuesday too), from the Mac |
| "ACTION NEEDED: sign in" or "1 of 3 views FAILED" | Same time, from the Mac, instead of the above |
| "Monday pull DID NOT RUN" | Monday and Tuesday ~9am, from Google, only if the Mac never reported |

### Step 7 (optional): Phone alerts

Mac notifications only help if you're at the Mac.

- **Telegram** (night-before check, run summary, failures):
  ```bash
  ./setup-sheets.sh telegram
  ```
- **Healthchecks.io** (free; emails you if a run **never happened**,
  e.g. the Mac was dead). Make a check: period 1 day, grace 2 days. Then:
  ```bash
  ./setup-sheets.sh healthcheck
  ```

## What you'll get each week

| When | What |
|---|---|
| Every day 6:00am | Vendor Central pull. **No email when it works.** An email only if it needs you (signed out, page changed, time period changed) |
| Every day 6:00pm | Evening check. Emails the evening before a review pull (Sunday, Monday), or any evening Vendor Central is signed out |
| Monday ~6:10am | Lifepro US, CA, MX: new reviews per star and per view, plus the "Latest data available" table |
| Tuesday ~6:05am | Joyberri and Sunello: same email |
| Monday / Tuesday ~9:00am | "DID NOT RUN", **only** if the Mac never reported in |

## When Amazon signs you out

Double-click **"Amazon Sign In"** on the Desktop. That's all: it checks both
sites, opens Chrome only for the one that's signed out, closes when you're in,
and reruns a pull that failed today. (Terminal: `npm run signin`.)

## Commands

| Command | What it does |
|---|---|
| `npm run pull` | Pull today's views now (and upload to the sheet) |
| `npm run pull -- --day=monday` | Pull Monday's views (Lifepro) |
| `npm run pull -- --view="Sunello/CA"` | Pull one view (store name/marketplace code from `views.json`) |
| `npm run signin` | Sign in to whatever is signed out (the Desktop file runs this) |
| `npm run vc-pull` | Vendor Central pull now |
| `npm run status` | Newest day of each kind of data |
| `npm run kpi` | Rebuild families + all KPI tables and show what's complete (pulls and the morning check do this by themselves) |
| `npm run check` | The daily check now: did today's pulls work? Retries failed ones. The 9:00am run always emails, subject starting "OK" or "PROBLEM, open now"; the 1:00pm run only on problems. `NOTIFY_DRY=1` prints instead of sending |
| `npm run families` | Rebuild the review families and show how many written reviews matched (the VC pull does this by itself) |
| `npm run login` / `npm run vc-login` | Older sign-in: one site, press Enter when done (`vc-login` also records the page in `discovery/vc/`) |
| `npm run stats` | Reviews per month and star, missing fields, last runs |
| `npm run remind` | Run the night-before check now (only if tomorrow has a pull) |
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
| `Wrong view: the top bar shows ...` | The switch didn't stick. Run that view again with `--view` |
| `does not sell in ...` / `pending registration` | That store isn't in that marketplace. Fine to ignore, or turn the view off in `views.json` |
| `on another Seller Central site` | Europe / Middle East: not built yet |
| Nothing happened Monday or Tuesday | Mac was off or unplugged. `pmset -g sched` should list the wake (`MT`). Run `npm run pull -- --day=monday` (or tuesday) |

A failed upload is retried on the next run: reviews stay marked "not yet in Sheets" until they're sent.

## Rules

| Do | Don't |
|---|---|
| Run it from this Mac, on your normal internet | Run it from a cloud server or a VPN |
| Keep it weekly | Run it many times a day |
| Leave Seller Central alone 6 to 6:15am Monday and Tuesday | Switch store or marketplace while it runs |
| Sign in by hand when asked | Put your password or OTP anywhere in this folder |
| Keep `.browser-profile/` on this Mac | Share or copy `.browser-profile/` (it's a signed-in session) |

## Files

| File | What it does |
|---|---|
| `views.json` | Which store + marketplace to pull on which day |
| `scrape.js` | The pull |
| `login.js` | Opens Chrome so you sign in |
| `remind.js` | Night-before check: power and sign-in |
| `lib/bcr.js` | What the reviews data looks like and which fields are saved |
| `lib/browser.js` | Opens Chrome, finds and clicks ›, listens to the page's data |
| `vc-pull.js` | The daily Vendor Central pull |
| `signin.js` | The easy sign-in for both sites |
| `status.js`, `lib/status.js` | "Latest data available" table |
| `lib/vc.js`, `lib/xlsx.js` | Reads the dashboard data and Amazon's Excel file, saves to the database |
| `lib/lock.js` | One browser job at a time |
| `lib/switcher.js` | Picks the store and marketplace in the top bar |
| `lib/views.js` | Reads `views.json`, picks today's views, review links per Amazon site |
| `lib/db.js` | Database tables: `reviews`, `raw_responses` (untouched data), `runs`, `view_runs` |
| `lib/sheets.js` | Sends new and changed reviews to the sheet |
| `apps-script/Code.gs` | Goes in the Google Sheet (Extensions > Apps Script) |
| `lib/notify.js` | Mac notification, Telegram, Healthchecks |
| `setup-sheets.sh` | Saves the sheet URL, token and alerts in the Mac Keychain |
| `install-schedule.sh` | Monday + Tuesday pulls, Sunday + Monday checks |
| `test/` | Tests and a fake reviews page (`npm test`) |

## Review families

On Amazon, child ASINs (colors, sizes) usually share one pool of reviews, and
Vendor Central shows that shared count on every child. `asin_family` groups them:
children of the same parent with the same review count and star rating are one
family. Some parents hold several families. `review_family` gives every written
review its family (by child ASIN, or by parent ASIN when the child isn't in VC).
Rebuilt after every pull. It grows by itself: ASINs known only from a written
review or the units tables join their parent's family (or get their own).
Details in `lib/families.js`.

## KPI tables

Rebuilt from the raw pulls after every pull and by the morning check (`lib/kpi.js`,
plan and formulas in `PLAN-kpi.md`): `family_daily`, `family_written`,
`family_ratings`, `family_units`, `kpi_family`, `kpi_brand`. Every row says if it
is complete and why not. Removed written reviews always count as written
reviews; `reviews.missing_since` records when one disappeared, and star-only adds
it back (a removal also lowers the VC count).

## Matching with other sources

`Review ID` is Amazon's own ID. Sellerlabs and Swapt use the same IDs, so you
can match on it to see exactly which reviews Sellerlabs misses.
