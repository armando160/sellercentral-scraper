// Review families: which ASINs share one review count on Amazon.
//
// On Amazon, child ASINs (colors, sizes) usually share ONE pool of reviews.
// Vendor Central shows that shared count on every child, so the children of
// one family have the SAME review count and the SAME star rating. Some parents
// hold more than one family (e.g. an old model and a new one under one parent).
//
// How we group (rebuilt after every pull, nothing typed by hand):
//   1. Only children of the same parent ASIN can be one family.
//   2. Two children are one family when, on the newest day both were in the
//      Vendor Central table, their review count AND star rating were equal.
//   3. A child with no review count is a family on its own.
//   4. ASINs we know from elsewhere (a written review, or the units tables)
//      but that have no VC review count join their parent's family when the
//      parent has only one; otherwise they are a family on their own.
// So the table grows by itself: a new ASIN joins as soon as any source has it.
//
// Tables it writes:
//   asin_family    one row per ASIN seen in Vendor Central
//   parent_family  one row per parent: its family, if the parent has only one
// View:
//   review_family  every written review with its family (matched by child
//                  ASIN, or by parent ASIN when the child isn't in VC)
//
// family_id is "F-" + the smallest ASIN in the family, so it stays the same
// from day to day unless the family itself changes.

export const FAMILY_SCHEMA = `
CREATE TABLE IF NOT EXISTS asin_family (
  asin          TEXT PRIMARY KEY,
  parent_asin   TEXT,
  family_id     TEXT NOT NULL,
  family_size   INTEGER,         -- children in this family
  confidence    TEXT,            -- shared (2+ children, count 5+), weak (2+ children, count under 5: could be chance), single,
                                 -- by parent (no VC count, joined its parent's only family), no count (no VC count, family of its own)
  source        TEXT,            -- where we know the ASIN from: vc ratings, vc units, written reviews
  brand         TEXT,            -- Brand name (PREFERRED_DISPLAY_NAME)
  color         TEXT,
  item_name     TEXT,
  rating_count  INTEGER,         -- newest family review count
  raw_rating    REAL,            -- newest family star rating
  as_of         TEXT,            -- ratings date of those two numbers
  first_seen    TEXT,            -- first ratings date this ASIN was in VC
  last_seen     TEXT,            -- last ratings date this ASIN was in VC
  rebuilt_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_asin_family_family ON asin_family(family_id);
CREATE INDEX IF NOT EXISTS idx_asin_family_parent ON asin_family(parent_asin);
CREATE TABLE IF NOT EXISTS parent_family (
  parent_asin   TEXT PRIMARY KEY,
  families      INTEGER,         -- how many families this parent holds
  family_id     TEXT             -- set only when families = 1
);
DROP VIEW IF EXISTS review_family;
CREATE VIEW review_family AS
  SELECT r.review_id, r.review_date, r.rating, r.marketplace, r.sheet_brand,
         r.child_asin, r.parent_asin, r.missing_since, a.family_id, a.confidence
  FROM reviews r LEFT JOIN asin_family a ON a.asin = r.child_asin;
`;

export function rebuildFamilies(db) {
  const rows = db.prepare(`SELECT v.ratings_date d, v.asin, v.parent_asin, v.rating_count c, v.raw_rating s,
      v.brand_display, v.color, r.item_name
    FROM vc_ratings_daily v LEFT JOIN vc_rows r ON r.pull_id = v.pull_id AND r.asin = v.asin
    ORDER BY v.ratings_date`).all();
  if (!rows.length) return { asins: 0, families: 0 };

  // Per ASIN: every day seen, and the newest row.
  const byAsin = new Map();
  for (const r of rows) {
    let a = byAsin.get(r.asin);
    if (!a) byAsin.set(r.asin, (a = { days: new Map(), first: r.d, last: null }));
    a.days.set(r.d, r);
    a.last = r; // rows are in date order
  }

  // Union-find inside each parent.
  const up = new Map([...byAsin.keys()].map((k) => [k, k]));
  const find = (x) => (up.get(x) === x ? x : (up.set(x, find(up.get(x))), up.get(x)));
  const byParent = new Map();
  for (const [asin, a] of byAsin) {
    const p = a.last.parent_asin || asin;
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p).push(asin);
  }
  for (const kids of byParent.values()) {
    for (let i = 0; i < kids.length; i++) {
      for (let j = i + 1; j < kids.length; j++) {
        const A = byAsin.get(kids[i]), B = byAsin.get(kids[j]);
        // newest day both were in the table
        const both = [...A.days.keys()].filter((d) => B.days.has(d)).sort();
        if (!both.length) continue;
        const a = A.days.get(both.at(-1)), b = B.days.get(both.at(-1));
        if (a.c != null && a.c === b.c && a.s === b.s) up.set(find(kids[i]), find(kids[j]));
      }
    }
  }

  const groups = new Map();
  for (const asin of byAsin.keys()) {
    const root = find(asin);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(asin);
  }

  // ASINs known from other sources but without a VC review count.
  const extra = db.prepare(`SELECT asin, MAX(parent_asin) parent_asin, MIN(src) source, MAX(brand) brand, MAX(title) title FROM (
      SELECT asin, parent_asin, 'vc units' src, NULL brand, NULL title FROM vc_units
      UNION ALL SELECT child_asin, parent_asin, 'written reviews', sheet_brand, product_title FROM reviews WHERE child_asin IS NOT NULL
    ) GROUP BY asin`).all().filter((r) => !byAsin.has(r.asin));

  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM asin_family; DELETE FROM parent_family;');
    const ins = db.prepare(`INSERT INTO asin_family (asin, parent_asin, family_id, family_size, confidence,
      brand, color, item_name, rating_count, raw_rating, as_of, first_seen, last_seen, rebuilt_at, source)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const kids of groups.values()) {
      kids.sort();
      const id = `F-${kids[0]}`;
      // the family's newest numbers: from the child seen most recently
      const newest = kids.map((k) => byAsin.get(k).last).sort((x, y) => (x.d < y.d ? 1 : -1))[0];
      const confidence = kids.length === 1 ? 'single' : (newest.c ?? 0) >= 5 ? 'shared' : 'weak';
      for (const k of kids) {
        const a = byAsin.get(k);
        ins.run(k, a.last.parent_asin, id, kids.length, confidence, a.last.brand_display, a.last.color,
          a.last.item_name, newest.c, newest.s, newest.d, a.first, a.last.d, now, 'vc ratings');
      }
    }
    // Families per parent so far (VC only), to place the extra ASINs.
    const parentFam = new Map();
    for (const r of db.prepare(`SELECT parent_asin p, COUNT(DISTINCT family_id) n, MIN(family_id) f
      FROM asin_family GROUP BY parent_asin`).all()) parentFam.set(r.p, r.n === 1 ? r.f : null);
    const famInfo = db.prepare(`SELECT MAX(brand) brand, MAX(rating_count) c, MAX(raw_rating) s, MAX(as_of) d
      FROM asin_family WHERE family_id = ?`);
    for (const x of extra) {
      const fam = x.parent_asin && parentFam.get(x.parent_asin);
      const info = fam ? famInfo.get(fam) : {};
      ins.run(x.asin, x.parent_asin, fam || `F-${x.asin}`, null, fam ? 'by parent' : 'no count',
        x.brand ?? info.brand ?? null, null, x.title, info.c ?? null, info.s ?? null, info.d ?? null, null, null, now, x.source);
    }
    db.exec(`UPDATE asin_family SET family_size = (SELECT COUNT(*) FROM asin_family f2 WHERE f2.family_id = asin_family.family_id)`);
    db.exec(`INSERT INTO parent_family (parent_asin, families, family_id)
      SELECT parent_asin, COUNT(DISTINCT family_id), CASE WHEN COUNT(DISTINCT family_id) = 1 THEN MIN(family_id) END
      FROM asin_family WHERE parent_asin IS NOT NULL GROUP BY parent_asin`);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  const n = db.prepare('SELECT COUNT(*) asins, COUNT(DISTINCT family_id) families FROM asin_family').get();
  return { asins: n.asins, families: n.families };
}
