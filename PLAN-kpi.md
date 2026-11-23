# Plan: the KPI layer

Goal: tables in `data/reviews.db` that a dashboard can read directly, with every
number traceable back to the raw pulls.

## Rules for every KPI table

1. **Raw data is the truth.** KPI tables are rebuilt from scratch after every pull
   (like `asin_family`). Never edit them by hand. If a rule changes, rebuild and every
   past number follows.
2. **Periods are Amazon's.** Weeks run Sunday to Saturday (same as VC units).
   Months are calendar months. Also day level where it makes sense.
3. **A period is only shown when both sources cover it.** Every row has a
   `complete` flag and the reason when it is 0.
4. **Counts are per family, units are per child.** Family counts are never added
   across children. Units are summed across the children of a family.
5. **Raw values are kept.** Negative star-only numbers (removals) stay in the table.
   The dashboard clamps them to 0 for display.

## What's already there (layer 0)

| Table / view | One row per | Holds |
|---|---|---|
| `reviews` | written review (SC) | stars, date, child + parent ASIN, marketplace, brand |
| `vc_rows` + `vc_pulls` | ASIN per VC pull | family review count, star rating (2 decimals), refresh dates |
| `vc_ratings_daily` (view) | ASIN per Amazon ratings date | the count and rating for that day, from the first good pull |
| `vc_units` | ASIN per week or month per pull | shipped + ordered units, `complete` when Amazon's units date passed the period end |
| `asin_family` | ASIN | its review family, built from VC (new) |
| `parent_family` | parent ASIN | its family, when the parent has only one (new) |
| `review_family` (view) | written review | the review's family and how it was matched (new) |

## To build (layers 1 to 5)

| # | Table | One row per | What it holds | Needs |
|---|---|---|---|---|
| 1 | `family_daily` | family per ratings date | count, rating, change since the previous snapshot, days between snapshots, `dropped` flag when the count went down | 2+ VC days (first change on 23 Nov) |
| 2 | `family_written` | family per day / week / month per marketplace | written reviews, their star sum, 1-2 star count | SC pulls; `complete` only up to each view's last pull |
| 3 | `family_ratings` | family per week / month | new ratings (count change), written, **star-only = change minus written**, star-only lower bound (sum of positive daily changes minus written), removals seen | 1 + 2; which marketplaces feed the VC count |
| 4 | `family_new_stars` | family per week / month | avg stars of all new ratings, of written, of star-only, and the error margin (±) | 1 + 2 |
| 5 | `family_units` | family per week / month | shipped and ordered units (newest final copy), plus the new sales source | `vc_units`; tomorrow's sales source |
| 6 | `kpi_family` | family per week / month | the 3 KPIs per unit (written, star-only, written + star), with and without a lag | 3 + 5 |
| 7 | `kpi_brand` | brand per week / month | same, added up per brand, plus the total | 6 |

### How the numbers are calculated

- **Star-only ratings** = (count at period end minus count at period start) minus written
  reviews dated in the period, for the same family and the marketplaces the count covers.
- **Avg stars of new ratings** = (count_end x rating_end minus count_start x rating_start)
  / (count_end minus count_start). The rating comes rounded to 2 decimals, so the margin
  is about 0.005 x (count_end + count_start) / new ratings. Shown only when the margin is
  0.1 star or less (roughly: new ratings at least 1/10 of the family total).
- **Avg stars of star-only** = (stars of all new ratings minus stars of the written ones)
  / star-only count. Same margin rule.
- **Per unit** = ratings in the period / units shipped (or ordered) in the period. The
  "with lag" version divides by the units from the period before (a review comes after
  delivery). Which lag fits best is measured once there's enough data.

## Other work the KPIs depend on

| # | Task | Why |
|---|---|---|
| A | **Removed written reviews**: add `missing_since` to `reviews`. A review is "missing" only if its date is inside the window the newest pull covered (the page shows the last 90 days, at most 1,000) and it wasn't seen | A removed written review also lowers the VC count. Without this, star-only looks too low that week |
| B | **Which marketplaces feed the VC count** (ask the colleague) | Decides whether CA and MX written reviews are subtracted too |
| C | **Snapshot gaps**: if a VC day is missing, use the newest snapshot on or before the period boundary and flag it | Daily pull can fail (signed out, Mac off) |
| D | **Weekly SC vs daily VC**: written reviews are only complete up to the last SC pull, so the newest days show "waiting for Monday" instead of a too-high star-only number | The mismatch you raised |
| E | **Family changes**: log when an ASIN moves to another family (Amazon merges or splits listings) | A merge makes the count jump; that jump is not new ratings |
| F | **Sales source** (tomorrow) and history | Units before October, CA and MX, SC sales |
| G | **Dashboard export**: the KPI tables are what gets uploaded | "Upload somewhere" |

## Status (22 Nov 2026)

Built: all 7 tables (`lib/kpi.js`, ratings + avg stars merged into `family_ratings`),
removal tracking (`reviews.missing_since`, set by the SC pull), snapshot gaps (task C),
families that grow from every source. Rebuilt after every pull and by `check.js`
(9:00am + 1:00pm). Decision: removed written reviews count permanently as written.
Waiting for data: first complete week needs VC ratings of 21 + 28 Nov and the
30 Nov SC pull (about 1 Dec). Still open: B (marketplaces), E (family changes log), F, G.

## Order (original)

1. `family_daily` and task C (can start now; first real change shows on 23 Nov).
2. Task A (removals) in the SC pull, before Monday's run if possible.
3. `family_written`, then `family_ratings` and `family_new_stars`.
4. `family_units` with VC, then add the new sales source.
5. `kpi_family`, `kpi_brand`.
