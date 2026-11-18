# CLAUDE.md: Amazon review scraper

Context for any Claude session working on this repo. Read README.md for how
people run it; this file is what a developer (or Claude) needs to change it.

## What it is

Weekly job on one Mac that pulls Lifepro's Amazon reviews from Seller Central
(Brands > Customer Reviews) into SQLite (`data/reviews.db`) and a Google Sheet,
then emails a summary. Main use: reviews per month, by product and star,
for the Lifepro data team. Sellerlabs undercounts (~85/month vs ~350 real).

## How it works

1. `scrape.js` opens real Google Chrome (Playwright, `channel: 'chrome'`) with a
   saved profile in `.browser-profile/` that a person signed in to by hand
   (`npm run login`). It never signs in itself: there is no OTP secret
   available for the account.
2. It loads the reviews page and **clicks the › arrow like a person**, 4 to 9 s
   apart. Each click makes the page fetch 50 reviews from Amazon's internal API;
   `lib/browser.js` listens to those responses (`page.on('response')`).
   **Do not call the API directly** from the script: the owner chose clicking
   so the traffic looks like normal browsing.
3. `lib/bcr.js` maps each review to a row. `lib/db.js` upserts by `review_id`.
4. `lib/sheets.js` POSTs new and changed rows to the Apps Script web app
   (`apps-script/Code.gs`), which upserts by Review ID into the sheet.
5. `lib/notify.js` sends the summary: email (through the same web app, which
   uses MailApp), Mac notification, optional Telegram / Healthchecks.

Schedule (`install-schedule.sh`, launchd): Monday 6:00 pull (`run-pull.sh`),
Sunday 18:00 check (`remind.js`: power + still signed in). The Mac wakes via
`sudo pmset repeat wakeorpoweron M 05:55:00`. Apps Script trigger
`checkMissedRun` (Monday ~9am) emails if no pull reported.

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
  Include marked as done.

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
  Mock env: `MOCK_TOTAL`, `MOCK_EXTRA`, `MOCK_LOGGED_OUT=1`.
- `raw_responses` keeps every API response untouched: after changing
  `lib/bcr.js`, `npm run reparse` rebuilds rows without hitting Amazon.
- After changing `apps-script/Code.gs`, someone must paste it into the sheet's
  Apps Script editor and **Deploy > Manage deployments > New version** (URL stays).
- Web app must be deployed with access **"Anyone"** (Workspace default
  "Anyone within Chai Vision" returns 401 to the Mac).

## Owner preferences

- Writing for the team: plain language, short steps, tables. No middle dots (·).
- Keep it simple: the team struggles with complex tooling.
- Run only from the owner's Mac on its normal connection. No cloud, no VPN,
  no rotating accounts or proxies.
