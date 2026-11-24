# Plan: Vendor Central export (ratings, star rating, units)

Status: **draft 3, 22 Nov 2026.** Built from 5 hand-downloaded exports (in
`../samples/vendor-central/`, never in this public repo) and screenshots.
Page: https://vendorcentral.amazon.com/custom-analytics/dashboard/01a20521-2769-7885-be72-fe3bc0a0d7ee
**Built 22 Nov:** daily pull (`vc-pull.js`), easy sign-in (`signin.js`, Desktop file), evening check, status table. First real pull 22 Nov: 265 ASINs, counts as of 19 Nov, units through 18 Nov, Export file matches the page data.
**Dashboard tiles (set up 22 Nov):** A "Reviews & Shipped Units" (Month to date, 265 ASINs; switched to Ordered Units on 23 Nov, see below), B "Ratings, 12 Months" (T12M, 387), C "Last Week" (top Week: Shipped + Ordered units, 288), D "Last Month" (top Month, 291). A table only lists ASINs that shipped a unit in its period, hence A + B together (388 ASINs). C and D only load when scrolled to; the pull scrolls. Units saved in `vc_units` (every copy kept, `complete` when Amazon's units date reaches the period end).
**Not built yet:** units history before Oct 2026, the KPI calculations.

## What the page recording showed (22 Nov)

The page loads its table in one data response (`/ca/metricdata/api/v1/metricdata`, all 265 rows). The script reads that response, the same way the reviews scraper reads the reviews page. It never calls Amazon itself.

| Question | Answer |
|---|---|
| Refresh date per metric? | **In the page's data, per column** (`dataSetDate`): Shipped Units **18 Nov**, review count, star rating and the rest **19 Nov**. No need to click the (i) icons |
| Ratings to 10 decimals? | Amazon's own definition says "Product Rating upto 10 decimal", but the page receives `"4.60"` as text. **Amazon rounds it before it reaches us**, in the page and the file. No way to get more from this page |
| Which countries are in the review count? | Amazon's definition: "Total ratings (with and without text) **across marketplaces contributing to the summary**". So it's **not only US**: it's the shared count, which can include other countries' reviews |
| Is there an orders metric? | Only "Vendor funding customer orders" (B2B discounts only). Not usable. Also available: **Ordered units** (adjusted for returns), **Customer returns quantity**, **Customer Initiated Returned %** |
| Does "Month to date" roll to December? | It's saved as `MTD`, a rolling choice (not fixed dates), so it should. Still checked on 1 Dec |
| Time period choices | Daily (latest day), WTD, MTD, QTD, YTD, last 7/15/30 days, each of the last 4 weeks (Sun to Sat), last 3 months, quarters, years. Data goes back to **2013** |
| Internal names | Customer review count = `TOTAL_RATING_COUNT`, Raw star ratings = `RAW_RATING`, Shipped Units = `QUANTITY_SHIPPED`, Ordered Units = `TOTAL_ORDERED_UNITS` (label "Net Ordered Units") |
| Change on 23 Nov 2026 | The tables now show **Ordered Units instead of Shipped Units**, and columns moved. The pull reads columns by id, takes either unit column (or both), and only requires ASIN, Parent ASIN, review count and star rating. Older pulls keep their shipped units; newer ones save ordered units |
| Watch out | The page sends activity reports to Amazon ("tricorder") all the time. Act like a person: few clicks, normal pauses |

## Goal

One database that answers, by brand, parent ASIN, child ASIN, color and period:

| # | KPI | Formula |
|---|---|---|
| 1 | Written reviews per unit | written reviews in period / shipped units in an earlier period |
| 2 | Star ratings (no text) per unit | star-only ratings in period / shipped units in an earlier period |
| 3 | All reviews per unit | (written + star-only) in period / shipped units in an earlier period |
| 4 | Star-only ratings in a period | (review count at end − review count at start) − written reviews in the period |
| 5 | Average stars of the new ratings | see "Average stars of the new ratings" below |

"Earlier period" = the delay between shipping and reviewing (a setting, e.g. reviews Aug to Oct / units Jul to Sep, the team's current 3-month method).

**Per unit, not per order.** The export only has **Shipped Units** ("Total Retail units shipped. Try Before You Buy units are excluded until they are purchased"). Orders wouldn't be right either:

- Amazon allows **one review per customer per product**, not one per order or per unit.
- So 2 units of the same product in one order can give at most 1 review: units **overcount** what can be reviewed.
- 5 different products in one order can give up to 5 reviews: orders would **undercount**.
- The ideal denominator, "customers who bought the product", isn't in Vendor Central.

So we use units and keep it the same forever. Trends over time are fair. Comparing products is fair except for products often bought in 2s or more (dumbbell pairs, bands): flag those.

## What the export file contains (checked 22 Nov)

| Fact | What it means for us |
|---|---|
| Columns follow "Edit metrics". Latest: ASIN, Item name, Customer review count, Raw star ratings, Brand name, Parent ASIN, Color Name, Shipped Units, Brand Name | Read columns **by header name**, never by position. Save every column, even ones we don't use yet |
| Two brand columns: "Brand name" and "Brand Name". They differ (JOYBERRI vs Lifepro, Lifepro vs LifePro) | Keep both, as given. Pick which one is "the brand" later |
| ASIN and Parent ASIN are `=HYPERLINK(...)` formulas | Take the ASIN out of the formula |
| Row 2 is "Total". Its review count is the biggest family, its star rating isn't an average of anything | Skip it |
| **No dates anywhere in the file**: not the period, not "Data last updated" | The script must read them from the page and save them next to the file. Without them the file is useless |
| Brands: Lifepro, JOYBERRI, PetCove, Oaktiv, Culvani, LOFT + IVY. 265 ASINs, 107 parents | We only pull written reviews for Lifepro, Joyberri and Sunello. For the other brands, KPIs 1, 3, 4 need their written reviews too (are they in Seller Central?) |
| Star rating has **2 decimals in the file itself** (the file stores `4.6`, `4.37`; it's not just display formatting) | Amazon rounds before the export. If the page's own data has more decimals, we read it from there (see "Full-precision ratings") |

### Review count is per "review family", not per ASIN

Amazon shares one count across the colors and sizes of a product. All children of the Waver show **30,978**. Adding children up gives 146,478, which is wrong.

But the family **isn't always the Vendor Central parent**. 7 parents have children with different counts. For example, parent B0FC1Y41HC has children with 21,420, 2,039 and 1,460.

**Rule:** a review family = the ASINs that show the same count in the same export, inside the same parent. We count and calculate per family, never per child, and never add children up.

### Each metric has its own refresh date

Clicking the (i) next to a column header shows "Last refreshed on". They differ: on 22 Nov, **Shipped Units was Nov 18** and the **ratings were Nov 19**, while the top of the table said "Data last updated on 11/19".

So the script clicks every (i), reads each date and saves it with the export:

| Saved per export | Used for |
|---|---|
| "Last refreshed on" of Customer review count and Raw star ratings | The date the counts belong to. This is the snapshot date for KPIs 2 to 5 |
| "Last refreshed on" of Shipped Units | The last day the units cover |
| "Data last updated on" (top of the table) | Kept as given |
| When we downloaded it | Kept as given |

Two downloads with the same ratings refresh date are the same snapshot: we keep the first and log the repeat.

### Full-precision ratings

The export rounds the star rating to 2 decimals. That makes KPI 5 noisy for big families. The page loads its own data to draw the table, like the reviews page does. `npm run vc-login` records those responses. If they carry the full number, the script reads the rating from what the page received (never calling Amazon itself), and the export file is kept as the backup.

### The time period box in a new month

The table is set to "Month to date". On 1 December it may roll to December by itself, or stay on November. The script **doesn't rely on it**: every run it reads the period on the page, saves it, and if it isn't the period it expects, it sets it (or stops and emails, until we know the picker). We'll watch it happen on 1 Dec.

## How it runs (daily)

| Step | What happens |
|---|---|
| 1. Signed in? | Opens the report with its own saved Chrome profile (`.browser-profile-vc`). If Amazon shows a sign-in page, it **stops**, sends a Mac notification and an email "ACTION NEEDED: sign in to Vendor Central" with the command to run. It never touches the sign-in form, so fake password fields can't catch it |
| 2. Night-before check | The existing evening check (`remind.js`) also opens Vendor Central and tells you if it's signed out, so you fix it the night before |
| 3. Read the page | "Data last updated on", Time period, Fulfillment channel, View, and the metrics chosen |
| 4. Export | One click on Export, like a person. Wait for the file |
| 5. Save raw | File kept untouched in `data/vc-exports/`, named with the download time and the "data last updated" date, plus a fingerprint (hash) |
| 6. Load | Into the same database as the reviews. If we read it wrong, reload from the saved files. No new download |
| 7. Report | A line in the email: "Vendor Central: 265 ASINs, counts as of 23 Nov 6:05am, units through 20 Nov" |

**Every day**, so removals don't hide inside a week (see removed reviews). If the ratings refresh date didn't move, the run just logs "no new data".

### Daily ratings vs. weekly written reviews

Star-only ratings = count change − written reviews. Written reviews are pulled weekly, so on a Thursday the counts are newer than the written reviews.

The fix is in the design, not a Monday correction: **nothing is stored pre-calculated**. Every number is worked out when asked, and only up to the **"complete through" date** = the last day covered by both sources. Days after it show as "waiting for Monday's review pull", never as a wrong number. Monday's pull moves the date forward and the numbers fill in by themselves.

If daily numbers are ever needed, the review pull can also run a short daily check (only the first 1 or 2 pages: the newest 50 to 100 reviews), keeping the full weekly pull.

### Units: by complete week and month, not by day

The review count and star rating don't depend on the time period (same counts whatever period is picked). Only units do. Units also arrive a day or more after the counts.

| Pull | When | Time period |
|---|---|---|
| Ratings snapshot | Every day | Whatever the table is on (Month to date). Keep the units too, labelled with their own date |
| Weekly units | Once the week's units are in (units date ≥ Saturday) | "Week N" (Sun to Sat) |
| Monthly units | Once the month's units are in | "Last month" |
| Corrections | One week later, pull the same week/month again | Same. Keep both versions |
| History, once | First run | Month by month back to Jan 2024 (units only; old counts don't exist) |

Daily units aren't needed: the KPIs are weekly or monthly, and the single-day choice only shows the newest day, which may not have units yet.

### Daily ratings vs. weekly written reviews

Star-only ratings = count change − written reviews. Written reviews are pulled weekly, so on a Thursday the counts are newer than the written reviews.

The fix is in the design, not a Monday correction: **nothing is stored pre-calculated**. Every number is worked out when asked, and only up to the **"complete through" date** = the last day covered by both sources. Days after it show as "waiting for Monday's review pull", never as a wrong number. Monday's pull moves the date forward and the numbers fill in by themselves.

If daily numbers are ever needed, the review pull can also run a short daily check (only the first 1 or 2 pages: the newest 50 to 100 reviews), keeping the full weekly pull.

### Getting daily units (to decide on the page)

| Option | How | Good | Bad |
|---|---|---|---|
| A. One day per export | Set Time period to a single day, export each day not saved yet | Exact daily units | More clicks on the date picker |
| B. Month to date | Export "Month to date" daily; units for a day = today's total − yesterday's | One export | Breaks if Amazon corrects old days |

A if the date picker allows it. Also re-download the last 7 days once a week, because Amazon can correct units.

## Database (same file as the reviews: `data/reviews.db`)

Rule: **save exactly what Amazon gave, with its dates. Calculate later.** Never overwrite an old export.

| Table | One row per | Columns |
|---|---|---|
| `vc_exports` | Download | id, downloaded at, data last updated, period start, period end, fulfillment channel, view, metrics list, file name, hash, row count, status |
| `vc_rows` | ASIN in a download | export id, ASIN, parent ASIN, item name, both brand columns, color, review count, star rating, shipped units (until 23 Nov), ordered units (from 23 Nov), the untouched row as JSON |
| `vc_families` | Family on a day | date, family id, parent ASIN, ASINs in it, review count, star rating |
| `reviews` | Written review (exists) | + `last_seen_at`, `missing_since`, `removed_between` (see removed reviews) |

Calculated, never typed in: KPIs 1 to 5, per family, per day, then rolled up to week and month.

## Average stars of the new ratings (KPI 5)

Amazon only gives the **average** of all ratings ever. From two days we can work out the average of **only the ratings that came in between**:

| | Ratings | Average | Total stars (ratings × average) |
|---|---|---|---|
| 1 Nov | 1,000 | 4.50 | 4,500 |
| 30 Nov | 1,100 | 4.45 | 4,895 |
| **New in November** | **100** | **3.95** | **395** |

The 100 new ratings brought 395 stars, so they average **3.95**. The lifetime 4.45 hides that November was much worse.

**Catch: the average is rounded to 2 decimals.** With a big family, the rounding is bigger than the change:

- Waver: 30,978 ratings. A rounding of 0.005 is ±155 stars. With 6 new ratings, the result is noise.
- Rule: the result is good to ±0.1 star only when the new ratings are **at least 1/10 of the family's ratings**. For a family of 500 that's 50 new ratings (weeks). For the Waver it's 3,100 (about a year).
- So: show it only when that rule passes. For big families, use the average of the **written** reviews instead (we have each one's stars) and label it.

## Removed reviews

Amazon removes reviews and ratings (fake-review sweeps, policy, customers deleting). We only see the **net** change in the count. It already happened: one family went from 2,040 to 2,039 in one day.

What one day's change is made of:

> change in count = written added − written removed + star-only added − star-only removed

| Piece | Can we see it? | How |
|---|---|---|
| Written added | Yes | Seller Central scraper, by review date |
| Written removed | **Partly** | A written review from the last 90 days that **disappears** from the reviews page was removed. We record when we last saw it. Reviews older than 90 days: invisible |
| Star-only added | Only net of removals | Count change − written |
| Star-only removed | No | Hidden inside the net |

What we do:

1. **Track written reviews that disappear.** Each pull records `last_seen_at` for every review it sees. A review that's inside the range the pull fully covered but wasn't seen gets `missing_since`. Missing on 2 pulls in a row = `removed_between` (last seen date, first missing date). Never deleted from the database. First check needed: does the page drop removed reviews, or mark them?
2. **Star-only, net:** count change − written added + written removed (the ones we caught). Can be negative. Keep it as is.
3. **Star-only, added (lower bound):** add up only the **days the count went up**. A removal day can't hide a whole week of new ratings this way. This is why we export **daily**: weekly snapshots would net removals against new ratings and we'd never know.
4. **Removal events:** a day where a family's count drops gets flagged with the size of the drop. A big drop across many families on one day = an Amazon sweep. KPIs show these days, they don't hide them.
5. **Display rule from Part 1:** the dashboard never shows negative counts (shows 0 and reports the gap). The database keeps the real negative.

## Other traps

| # | Trap | How we handle it |
|---|---|---|
| 1 | **Family changes**: an ASIN joins or leaves a family (variation merged or split). The count jumps by thousands | Detect when an ASIN's count suddenly matches another family. Flag that day; leave its change out of KPIs |
| 2 | **Date written vs. date counted**: a review written on the 31st may be counted on the 2nd | Report by week or month. After 3 weeks of daily data, measure the delay on small families |
| 3 | **Which countries are in the count.** Amazon says "across marketplaces contributing to the summary" | Subtract written reviews from **every** marketplace we pull for that product. Then test on small families: does the count move with CA/MX/UK written reviews? Countries we don't pull make star-only look higher: flag per brand |
| 4 | **Units corrected later** | Re-download the last 7 days weekly; keep every version |
| 5 | **Two exports with the same data** | The hash shows it; we keep the first and log the repeat |
| 6 | **Page changes** (new column, renamed metric) | Columns read by name. A missing needed column stops the load and emails, never guesses |

## Next steps

1. **Me:** build `vc-pull.js` against a fake copy of the page (like the reviews mock): sign-in check, read the table's data with its dates, click Export as backup, save both untouched, load into the database.
2. **Me:** weekly and monthly units, and the one-time history back to Jan 2024.
3. **You + me:** first real run, then daily.
4. **1 Dec:** check the Time period rolled to December.

Open questions for you: whether PetCove, Oaktiv, Culvani and LOFT + IVY have a Seller Central account we can pull written reviews from.
