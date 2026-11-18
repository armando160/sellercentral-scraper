# Plan: more brands and marketplaces

Status: **plan only, nothing built yet** (written 18 Nov 2026).
Today the scraper pulls one view: store **LIFEPRO OUTLET**, marketplace
**United States**, every Monday.

## Goal

| What | How often |
|---|---|
| Lifepro, United States | Every Monday (as today) |
| Every other brand and marketplace | Less often (every 2 or 4 weeks) |

One sheet, one email per run, same Mac, same sign-in process.

## What we know

1. The reviews page shows one **store + marketplace** at a time. The store and
   marketplace are picked in the top bar ("LIFEPRO OUTLET | United States").
   Changing it changes it for every open Seller Central tab.
2. The page has a **Brand filter showing "(3)"**: 3 brands in this store.
   But the first pull (998 reviews) was **100% LifePro**. So either the other
   2 brands have almost no reviews in the last 90 days, or the filter was
   limited to LifePro. **Must check** (question 1).
3. Each view only shows the **last 90 days**, max **1,000 reviews**.
   So each view must be pulled before 1,000 new reviews pile up.
   Lifepro US gets ~350/month, so weekly is very safe. A view with fewer than
   ~300 reviews a month is safe at every 4 weeks.
4. Every review already saves its `brand`. Marketplace and store are not saved
   yet (today they're always LIFEPRO OUTLET / US).

## Questions for Armando (answer before building)

1. **Brands:** which brands, and are they all in the LIFEPRO OUTLET store?
   (Chai Vision brands seen elsewhere: Lifepro, JoyBerri, PetCove, LOFT, PurrTek.)
   Open the reviews page > Brand filter: which 3 names are listed?
2. **Other stores:** are some brands in a **different Seller Central account**?
   Does your login reach them with the account switcher (top bar), or is it a
   different login?
3. **Marketplaces:** which ones? US, Canada, Mexico are in the same North
   America login. UK / Europe use a different site (sellercentral-europe) and
   probably a separate sign-in.
4. **How often** for the others: every 2 weeks or every 4 weeks?
5. **Sheet:** one sheet with Brand and Marketplace columns (recommended), or
   one sheet per brand?
6. **Email:** one combined Monday email (recommended), or one per brand?

## Build plan (after the answers)

### Step 1: A list of "views" to pull

A new file `views.json`, one line per store + marketplace:

| name | store | marketplace | every |
|---|---|---|---|
| lifepro-us | LIFEPRO OUTLET | United States | 1 week |
| lifepro-ca | LIFEPRO OUTLET | Canada | 4 weeks |
| other-store-us | (store name) | United States | 2 weeks |

Brand isn't needed here: each review already says its brand.

### Step 2: Switch store / marketplace like a person

Before reading a view, the script clicks the top-bar switcher and picks the
store and marketplace, then checks the top bar shows them before reading.
If it can't find the option, it skips that view and says so in the email.
First, watch how the switcher works in the browser (same as we did for the
reviews page): its menu, any "Select account" page, and what the address does.

### Step 3: One Monday job decides what's due

Keep the single Monday 6:00am schedule. Each Monday the script:
1. Always pulls **lifepro-us**.
2. Pulls any other view whose last good pull was **at least its "every" ago**.
3. Switches back to LIFEPRO OUTLET / United States at the end (so the
   Seller Central tabs you open later aren't left on another market).

This keeps one wake-up, one sign-in check and one email. A pause of a few
minutes between views keeps it looking human. Rough time: ~3 min per view.

### Step 4: Save store and marketplace

- Database: add `store` and `marketplace` columns. Existing rows = LIFEPRO OUTLET / United States.
- Runs table: one row per view per run, so "last good pull" is per view.
- Review links use the right Amazon site (amazon.ca, amazon.com.mx, ...).

### Step 5: Sheet

- Reviews tab: add **Brand**, **Store**, **Marketplace** columns.
- Monthly tab: month x brand x marketplace counts.
- By product: unchanged, plus a brand column.
- Apps Script gets updated (paste + New version, as before).

### Step 6: Email

One email after the Monday run:
- per view: pulled or skipped (not due), new reviews, new 1-2 star
- new 1-2 star reviews grouped by brand
- any view that failed and why

Sunday check stays the same. Missed-run check stays the same.

### Step 7: Test, then roll out

1. Fake site: add a store/marketplace switcher to `test/mock-site.js`, test
   switching, skipping, "due" logic, and switching back.
2. Real: run each new view **once by hand** while watching, check the sheet.
3. Then turn it on in the Monday job.

### Europe / UK (if needed)

Separate site and sign-in. Would need its own saved Chrome profile
(`npm run login -- --region=eu`) and its own Sunday sign-in check. Build only
if question 3 says yes. Same 90-day / 1,000 limits apply.

## Risks

| Risk | What we do |
|---|---|
| More page loads on Mondays looks less human | Pauses between views; only pull views that are due |
| Switching marketplace changes it for your open tabs | Runs at 6am; switch back to Lifepro US at the end |
| A busy view passes 1,000 reviews between pulls | Email warns when a view's 90-day total is near 1,000; then pull it more often |
| Different login for another store or Europe | Separate saved profile per login; Sunday check covers each |
