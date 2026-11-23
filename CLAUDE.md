# CLAUDE.md: Amazon review scraper

Context for any Claude session working on this repo. Read README.md for how
people run it; this file is what a developer (or Claude) needs to change it.

## What it is

Weekly job on one Mac that pulls Amazon reviews from Seller Central
(Brands > Customer Reviews) for several **views** (store + marketplace, in
`views.json`) into SQLite (`data/reviews.db`) and one Google Sheet, then emails
one summary per run. Monday: LIFEPRO OUTLET US/CA/MX. Tuesday: Joyberri LLC and
Sunello US/CA/MX. Europe / Middle East views exist but are `enabled: false`. Main use: reviews per month, by product and star,
for the Lifepro data team. Sellerlabs undercounts (~85/month vs ~350 real).

## How it works

1. `scrape.js` opens real Google Chrome (Playwright, `channel: 'chrome'`) with a
   saved profile in `.browser-profile/` that a person signed in to by hand
   (`npm run login`). It never signs in itself: there is no OTP secret
   available for the account.
2. For each view of the day (`lib/views.js` `pickViews`), `lib/switcher.js`
   picks the store + marketplace in the top bar by clicking, and checks the
   header. Only then does the scraper keep the data the page loads (responses
   before the header check are queued, responses between views are dropped).
   At the end it switches back to `home` in `views.json` (LIFEPRO OUTLET / US).
3. It loads the reviews page and **clicks the › arrow like a person**, 4 to 9 s
   apart. Each click makes the page fetch 50 reviews from Amazon's internal API;
   `lib/browser.js` listens to those responses (`page.on('response')`).
   **Do not call the API directly** from the script: the owner chose clicking
   so the traffic looks like normal browsing.
4. `lib/bcr.js` maps each review to a row. `lib/db.js` upserts by `review_id`
   and stores `sheet_brand`, `store`, `marketplace` (code) from the view the
   review was **first** seen in (never changed later). Per-view results go to
   `view_runs`. Rows from before views existed were migrated to Lifepro / US.
5. `lib/sheets.js` POSTs new and changed rows to the Apps Script web app
   (`apps-script/Code.gs`), which upserts by Review ID into the sheet.
6. `lib/notify.js` sends the summary: email (through the same web app, which
   uses MailApp), Mac notification, optional Telegram / Healthchecks.

Schedule (`install-schedule.sh`, launchd): Monday and Tuesday 6:00 pull
(`run-job.js pull`; `scrape.js` picks the views whose `day` is today), Sunday and
Monday 18:00 check (`remind.js`: power + still signed in; exits quietly if
tomorrow has no views). The Mac wakes via
`sudo pmset repeat wakeorpoweron MT 05:55:00`. Apps Script trigger
`checkMissedRun` (Monday and Tuesday ~9am) emails if no pull reported in 12h.

## Seller Central page facts (checked 2026-11-18)

- Page: `https://sellercentral.amazon.com/brand-customer-reviews/?includeDone=true&pageSize=50`.
  Not in the Seller Central menus; reachable only by this link.
- Data: `GET /brandcustomerreviews/api/reviews?pageId=N&pageSize=50&sortByType=REVIEW_CREATED_DATE&isAscending=false&includeDone=true`
  returns `{ totalReviewCount, totalPageCount, pageId, pageSize, validMarketplace, reviews[] }`.
- Review fields: `reviewId`, `reviewRating`, `reviewTitle`, `reviewText`,
  `reviewCreatedTimestamp` (ISO), `asin` (= **parent** ASIN), `childAsin`,
  `asinTitle`, `brandName`, `reviewIsVerifiedPurchase`, `reviewIsVineReview`,
  `reviewHasImages`, `reviewIsVideo`, `reviewIsRepliedTo`, `reviewMarkedAsDone`,
  `asinTotalReviewCount`, `asinWeightedStarRating`, `asinThumbnail`,
  `reviewAuthorPublicName` (**never stored**).
- Limits: only the **last 90 days**; at most **1,000** per sort direction
  (pageId 0 to 19; pageId 20 returns HTTP 400). The UI has no sort control,
  only a page-size dropdown (10/25/50). So it must run at least every ~2 months.
- Pager: `<kat-pagination>` (shadow DOM). Next = `[part="pagination-nav-right"]`;
  it has class `end` when there is no next page. Clicking it adds
  `pageNumber=N` to the URL.
- Sign-in page has a hidden decoy input `#ap-credential-autofill-hint`
  (type=password), so detection uses `:visible` selectors.
- Filters on the page: Brand (3 brands), Order Type, Star rating, Time Period,
  Include marked as done. LIFEPRO OUTLET's brands are LifePro, Waver, Rumblex;
  Waver and Rumblex are a listing mistake and count as Lifepro.
- The page shows "N review(s)" = `totalReviewCount`. 90-day counts on
  2026-11-18: Lifepro US ~1,044, Lifepro CA 88, Joyberri US 65, Sunello US 1.

## Store / marketplace selector (checked 2026-11-18)

- Header: `.dropdown-account-switcher-header`, labels
  `.dropdown-account-switcher-header-label-global` (store) and
  `...-label-regional` (marketplace name, e.g. "United States").
- Click the header: list of `.dropdown-account-switcher-list-item[title]`.
  Stores are plain items; their marketplaces are the
  `...-list-item-indented` items right after them. A store's
  `.dropdown-account-switcher-list-item-icon` only expands it (class
  `...-icon-expanded` when open); nothing switches until a marketplace is clicked.
- Clicking a marketplace switches for **every open Seller Central tab** and
  navigates to `/home?mons_sel_mkid=...` (ends on `/amazonsell/business...`).
  The script then opens the reviews URL again.
- Stores: High Cloud Sales, Joyberri LLC, Kitchenova Global, LIFEPRO OUTLET,
  Loft and Ivy, Oaktiv, Sunello. Only LIFEPRO OUTLET, Joyberri LLC and Sunello
  are pulled. Not-ready marketplaces have titles like
  "Australia (pending registration)" (treated as not available).
- Canada and Mexico work on sellercentral.amazon.com with the same sign-in.
- **Europe (tested with United Kingdom) redirects to
  sellercentral.amazon.co.uk and asks for a new sign-in.** The switcher
  reports that as `other_site` and the view is skipped. Building Europe means
  a second profile / sign-in for that site (see PLAN-expansion.md).
- `/brandcustomerreviews/api/context` returns the brands and
  `amazonLinks.home` (e.g. https://amazon.ca) for the current view.

## Secrets (macOS Keychain, service `amazon-review-scraper`)

`sheets-url`, `sheets-token`, optional `telegram-token`, `telegram-chat`,
`healthcheck-url`. Read by `lib/secrets.js`. Never put them in files.
`local/` (git-ignored) may hold a copy of Code.gs with the token filled in.
Tests use `SECRETS_FROM_ENV=1` with `SECRET_<NAME>` env vars instead.

## Working on it

- Node >= 22.13 (uses built-in `node:sqlite`). Only dependency: playwright.
- `npm test` runs unit tests. For end-to-end, `test/mock-site.js` copies the
  real page (same API shape, kat-pagination, 20-page cap) plus a fake web app:
  ```
  node test/mock-site.js 8899 &
  REVIEWS_URL='http://localhost:8899/brand-customer-reviews/?includeDone=true&pageSize=50' \
  PROFILE_DIR=/tmp/p DB_PATH=/tmp/r.db HEADLESS=1 MIN_DELAY_SEC=0 MAX_DELAY_SEC=0.3 \
  NO_MAC_NOTIFY=1 SECRETS_FROM_ENV=1 SECRET_SHEETS_URL=http://localhost:8899/sheets \
  SECRET_SHEETS_TOKEN=tok-test node scrape.js
  ```
  Mock env: `MOCK_TOTAL`, `MOCK_EXTRA`, `MOCK_LOGGED_OUT=1`,
  `MOCK_FAIL="Joyberri LLC|Canada"` (that view's data returns 500).
  The mock has the same top-bar selector (cookie `sel`); United Kingdom goes
  to 127.0.0.1 (another host) to test `other_site`. Use
  `VIEWS_FILE=test/views.test.json` and `--day=monday|tuesday` or `--view=`.
- `raw_responses` keeps every API response untouched: after changing
  `lib/bcr.js`, `npm run reparse` rebuilds rows without hitting Amazon.
- After changing `apps-script/Code.gs`, someone must paste it into the sheet's
  Apps Script editor, run `setup()` once (migrates the Reviews layout by
  header name, keeps a hidden backup tab, rebuilds Monthly and By product,
  styling, triggers), and **Deploy > Manage deployments > New version** (URL stays).
- Sheet: Reviews columns are `HEADERS` in Code.gs (Brand = D, Marketplace = E,
  Stars = F, Month = C as text "yyyy-mm"). Monthly is formulas (COUNTIFS over
  the last 12 months). Dates always run across the top (X axis): months are
  columns B..M oldest to newest, N = total, each row one number. Explore
  dropdowns are in the row under its title (found by the "Brand:" label). By product is values
  rebuilt by `buildByProduct_` on every upload.
- Web app must be deployed with access **"Anyone"** (Workspace default
  "Anyone within Chai Vision" returns 401 to the Mac).

## Owner preferences

- Writing for the team: plain language, short steps, tables. No middle dots (·).
- Keep it simple: the team struggles with complex tooling.
- Run only from the owner's Mac on its normal connection. No cloud, no VPN,
  no rotating accounts or proxies.

## Vendor Central (added 22 Nov 2026)

- `vc-pull.js` daily 6:00am (`run-job.js vc`, waits 60s so the Monday/Tuesday review
  pull takes the browser first; `lib/lock.js` keeps one browser job at a time).
- Dashboard data comes from the page's own response `/ca/metricdata/api/v1/metricdata`
  (`metricsData.data.rowData`, values are strings like "30,978"; each column's
  `dataSetDate` = its "Last refreshed on"). Export button `[data-testid="btn-export"]`
  downloads the .xlsx directly. Both kept in `data/vc/`; `compareExport` checks they match.
- Own Chrome profile `.browser-profile-vc/`. `signin.js` = the Desktop "Amazon Sign In"
  file: checks both sites headless, opens Chrome only for the signed-out one,
  polls until signed in (never touches the form), reruns a pull that failed today.
- Emails explain themselves (WHAT HAPPENED / WHY IT MATTERS / WHAT TO DO / IF YOU DO
  NOTHING / ABOUT THIS EMAIL). Success is silent.
- Mock: `test/mock-site.js` serves `/custom-analytics/dashboard/<id>`; env
  `MOCK_VC_LOGGED_OUT`, `MOCK_VC_PERIOD`, `MOCK_VC_RATINGS_DATE`, `MOCK_VC_NO_EXPORT`,
  `MOCK_VC_DROP_COL`. Run with `VC_URL=http://localhost:PORT/custom-analytics/dashboard/test`
  `VC_PROFILE_DIR=... DB_PATH=...`. Real sample files are in `../samples/` (never commit them:
  this repo is public and they have sales data).
- The dashboard has 4 tiles (A Month to date, B T12M, C last Week, D last Month); the
  pull scrolls so C and D load, tells them apart by the request's dateRanges type
  (RECURRINGLY/TRAILINGLY/WEEKLY/MONTHLY, `tilePeriod`), merges A+B into vc_rows and saves
  every tile with Shipped Units into vc_units. A tile only lists ASINs that shipped in its period.
- Not built yet: units history, the KPI calculations (families, star-only, removed reviews).
