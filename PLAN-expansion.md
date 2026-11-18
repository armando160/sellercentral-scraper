# Plan: more stores, marketplaces and a better sheet

Status: **plan only, nothing built yet.** Last updated 18 Nov 2026 with
Armando's answers. Today the scraper pulls one view (LIFEPRO OUTLET, United
States) every Monday.

## What we're pulling

A **view** = one store + one marketplace on the Customer Reviews page.

| Store (top-bar selector) | Brand in sheet | Marketplaces | Day |
|---|---|---|---|
| LIFEPRO OUTLET | Lifepro | North America + Europe + Middle East (below) | Monday |
| Joyberri LLC | Joyberri | North America | Tuesday |
| Sunello | Sunello | North America | Tuesday |

Not included: High Cloud Sales, Kitchenova Global, Loft and Ivy, Oaktiv.

**Lifepro marketplaces**, in order of priority:

| Phase | Marketplaces | Access |
|---|---|---|
| 1 | US, Canada, Mexico | Has access |
| 2 | UK, Germany, France, Italy, Spain | Requested |
| 3 | Netherlands, Belgium, Sweden, Poland, UAE, Saudi Arabia | Requested |

"North America" = US, Canada, Mexico. If a store doesn't sell in one of
them, that view is skipped automatically (the run notes "no reviews / not
available" in the email).

LIFEPRO OUTLET's Brand filter also lists Waver and RumbleX. That's a listing
setup mistake, not real brands: everything in the store counts as **Lifepro**.
Amazon's brand field is not shown in the sheet.

## Sheet design (one shared sheet)

No separate sheet per brand. One sheet, three tabs:

### Tab 1: Reviews (all data)

Same as today plus 2 columns near the front: **Brand** (Lifepro / Joyberri /
Sunello, set from the store) and **Marketplace** (US, CA, MX, UK, DE...). Filters on, header frozen, banded rows, stars
colored (1-2 red, 3 yellow, 4-5 green), review text wrapped. Review link
points to the right Amazon site (amazon.co.uk, amazon.de, ...).

### Tab 2: Monthly (the summary people read)

Top to bottom:

1. **Global summary**: one row per month, all brands and markets. Reviews,
   1-2 star count, % 1-2 star, average stars. Small trend chart next to it.
2. **Lifepro summary**: same table, Lifepro only, plus one column per
   marketplace (US, CA, MX, UK, DE...) with that month's review count.
3. **Explore table**: two dropdowns at the top (**Brand**, **Marketplace**,
   each with "All"). The table below updates: month, reviews, 1 to 5 star
   counts, % 1-2 star, average. Made with formulas, no code.

Styling: brand colors for headers, big readable numbers, months newest first,
% and averages formatted, conditional colors on average stars and % low-star.

### Tab 3: By product

Parent ASIN, product name, brand, marketplace, reviews, average stars,
1-2 star count. Sorted by reviews. Filters on.

### Migration

Existing 998 rows get Brand = Lifepro, Marketplace = US. The Apps Script
rebuilds Monthly and By product with the new layout (paste + New version,
like before).

## How a run works

- **Monday 6:00am**: all Lifepro views, one after another.
- **Tuesday 6:00am**: Joyberri and Sunello North America views.
- For each view: pick the store and marketplace in the top-bar selector (by
  clicking, like a person), check the top bar shows them, then click through
  the review pages as today. A short pause between views.
- At the end: switch back to LIFEPRO OUTLET / United States.
- Time: about 3 min for a busy view (US), under a minute for small ones.
  Monday with all Lifepro markets: ~20 to 30 min.
- **One email per run** (one Monday, one Tuesday): per view, how many new
  reviews and new 1-2 star reviews, which views were skipped or failed, then
  the new 1-2 star reviews grouped by brand and marketplace.

Schedule changes:
- Mac wakes Monday **and** Tuesday: `sudo pmset repeat wakeorpoweron MT 05:55:00`.
- Night-before check (power + signed in): Sunday 6pm and Monday 6pm.
- Google's "did not run" email: Monday and Tuesday ~9am.

## Europe and Middle East (phase 2 and 3)

Europe (UK, DE, FR, IT, ES, NL, BE, SE, PL) uses a different Seller Central
site (sellercentral-europe.amazon.com). UAE and Saudi Arabia may be separate
again. Before building:
- Check if the reviews page link works there and looks the same.
- Check if it needs a separate sign-in. If yes: a second saved Chrome profile
  and `npm run login -- --region=eu`, checked by the night-before check too.
- Same limits: last 90 days, max 1,000 reviews per view.

## Build order

1. **Watch the selector** in the browser: how the store / marketplace picker
   works, what the page and address do after switching. Nothing gets built
   before this.
2. **Views list** (`views.json`): store, marketplace, brand label, day.
3. **Switching + per-view runs** in the scraper, tested on the fake site
   (add a fake selector to `test/mock-site.js`).
4. **Database**: add brand, store, marketplace; existing rows = Lifepro / US.
5. **Sheet redesign** (Apps Script): new columns, Monthly tab with the 3
   tables and dropdowns, styling, By product.
6. **Email per run** with per-view lines.
7. **Schedule**: Tuesday run, Monday 6pm check, Mac wake on Tuesday.
8. **First real runs by hand**, watching: Lifepro CA and MX, Joyberri US,
   Sunello US. Check the sheet. Then turn on the schedule.
9. **Europe** once access is granted: phase 2 markets first.

## Still open

- Exact marketplaces per store in North America (does Joyberri / Sunello sell
  in Canada and Mexico?). The selector will show this in step 1.
- Europe / Middle East access (requested).

## Risks

| Risk | What we do |
|---|---|
| More page loads look less human | Pauses between views; 2 days instead of 1 |
| Switching marketplace changes it for your open tabs | Runs at 6am; switches back to Lifepro US at the end |
| A busy view passes 1,000 reviews in 90 days | Email warns when a view is near 1,000; weekly is fine for all today |
| Europe needs another sign-in | Second saved profile; night-before check covers both |
