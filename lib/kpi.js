// The KPI layer: tables a dashboard reads directly. All of them are rebuilt
// from scratch from the raw pulls after every pull (never edit them by hand:
// change the rule here and rebuild, and every past number follows).
//
//   family_daily    family per Vendor Central ratings day: count, rating, change since the snapshot before
//   family_written  family per day / week / month per marketplace: written reviews (removed ones INCLUDED)
//   family_ratings  family per week / month: new ratings, written, star-only, avg stars of new ratings
//   family_units    family per week / month: shipped + ordered units
//   kpi_family      family per week / month per units basis: the 3 per-unit KPIs
//   kpi_brand       brand per week / month per units basis: the same, added up (+ "All brands")
//
// Rules (PLAN-kpi.md has the reasons):
//   - Weeks run Sunday to Saturday (like Vendor Central units). Months are calendar months.
//   - Counts are per family (never added across children). Units are added across children.
//   - Removed written reviews always count as written reviews (we earned them).
//     But a removal also lowers the VC review count, so star-only adds them back:
//       star-only = (count at end - count at start) - written in period + written removed in period
//   - Negative results are kept as they are. The dashboard shows them as 0.
//   - Every row says whether it is complete, and why not.
import { rebuildFamilies } from './families.js';

// Which marketplaces' written reviews are inside the Vendor Central review
// count. Amazon: "across marketplaces contributing to the summary". To be
// confirmed with the team; US only until then.
export const VC_COUNT_MARKETS = ['US'];
// A VC snapshot may be this many days older than the period boundary (a
// missed daily pull). Older than that, the period is not complete.
const MAX_GAP_DAYS = 2;

// ---- dates (YYYY-MM-DD strings, calendar days) ----
const D = (s) => new Date(`${s}T00:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);
export const addDays = (s, n) => iso(new Date(D(s).getTime() + n * 864e5));
const daysBetween = (a, b) => Math.round((D(b) - D(a)) / 864e5);
export const weekStart = (s) => addDays(s, -D(s).getUTCDay());
const monthStart = (s) => `${s.slice(0, 7)}-01`;
const monthEnd = (s) => { const d = D(monthStart(s)); d.setUTCMonth(d.getUTCMonth() + 1); return addDays(iso(d), -1); };
export function periodOf(kind, day) {
  if (kind === 'day') return [day, day];
  if (kind === 'week') { const s = weekStart(day); return [s, addDays(s, 6)]; }
  return [monthStart(day), monthEnd(day)];
}
function periodsBetween(kind, from, to) {
  const out = [];
  for (let [s, e] = periodOf(kind, from); s <= to; [s, e] = periodOf(kind, addDays(e, 1))) out.push([s, e]);
  return out;
}
const round = (x, n = 4) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** n) / 10 ** n);

const SCHEMA = `
DROP TABLE IF EXISTS family_daily;
CREATE TABLE family_daily (
  family_id TEXT, day TEXT,            -- Amazon's ratings date
  rating_count INTEGER, raw_rating REAL,
  prev_day TEXT, prev_count INTEGER, prev_rating REAL,
  gap_days INTEGER,                    -- days since the previous snapshot (1 = normal)
  count_change INTEGER,                -- rating_count - prev_count (negative = ratings removed)
  PRIMARY KEY (family_id, day)
);
DROP TABLE IF EXISTS family_written;
CREATE TABLE family_written (
  family_id TEXT, period_kind TEXT, period_start TEXT, period_end TEXT, marketplace TEXT,
  written INTEGER,                     -- written reviews dated in the period, removed ones included
  stars_sum INTEGER, low_star INTEGER, -- low_star = 1 or 2 stars
  removed_since INTEGER,               -- of those, how many are now missing from Amazon
  complete INTEGER,                    -- 1 if Seller Central was pulled after the period ended
  covered_through TEXT,                -- last day Seller Central covers for this marketplace
  PRIMARY KEY (family_id, period_kind, period_start, marketplace)
);
DROP TABLE IF EXISTS family_ratings;
CREATE TABLE family_ratings (
  family_id TEXT, period_kind TEXT, period_start TEXT, period_end TEXT,
  start_day TEXT, count_start INTEGER, rating_start REAL,   -- VC snapshot just before the period
  end_day TEXT, count_end INTEGER, rating_end REAL,         -- VC snapshot at the end of the period
  new_ratings INTEGER,                 -- count_end - count_start (written + star-only, all VC marketplaces)
  written INTEGER,                     -- written reviews in the period, VC marketplaces only, removed included
  written_removed INTEGER,             -- written reviews found missing during the period (added back)
  star_only INTEGER,                   -- new_ratings - written + written_removed (raw; can be negative)
  rises_sum INTEGER, drops_sum INTEGER,-- sum of daily increases / decreases inside the period
  new_stars_sum REAL,                  -- count_end*rating_end - count_start*rating_start
  avg_new_stars REAL,                  -- of all new ratings
  avg_written_stars REAL,
  avg_star_only_stars REAL,
  margin_new REAL, margin_star_only REAL, -- +/- stars from Amazon rounding the rating to 2 decimals; trust when <= 0.1
  complete INTEGER, why_not TEXT,
  PRIMARY KEY (family_id, period_kind, period_start)
);
DROP TABLE IF EXISTS family_units;
CREATE TABLE family_units (
  family_id TEXT, period_kind TEXT, period_start TEXT, period_end TEXT,
  shipped INTEGER, ordered INTEGER, asins INTEGER,
  source TEXT,                         -- vc (more sources later)
  complete INTEGER,                    -- 1 when Amazon's units date reached the period end
  PRIMARY KEY (family_id, period_kind, period_start, source)
);
DROP TABLE IF EXISTS kpi_family;
CREATE TABLE kpi_family (
  family_id TEXT, brand TEXT, period_kind TEXT, period_start TEXT, period_end TEXT,
  basis TEXT,                          -- shipped, ordered, shipped prev period, ordered prev period
  units INTEGER, written INTEGER, star_only INTEGER, total_new INTEGER,
  written_per_unit REAL, star_only_per_unit REAL, total_per_unit REAL,
  complete INTEGER, why_not TEXT,
  PRIMARY KEY (family_id, period_kind, period_start, basis)
);
DROP TABLE IF EXISTS kpi_brand;
CREATE TABLE kpi_brand (
  brand TEXT, period_kind TEXT, period_start TEXT, period_end TEXT, basis TEXT,
  families INTEGER,                    -- complete families added up
  units INTEGER, written INTEGER, star_only INTEGER, total_new INTEGER,
  written_per_unit REAL, star_only_per_unit REAL, total_per_unit REAL,
  avg_new_stars REAL,                  -- all new ratings of those families
  PRIMARY KEY (brand, period_kind, period_start, basis)
);
DROP TABLE IF EXISTS kpi_meta;
CREATE TABLE kpi_meta (key TEXT PRIMARY KEY, value TEXT);
`;

export function rebuildKpis(db, { today = new Date().toLocaleDateString('en-CA') } = {}) {
  rebuildFamilies(db);
  db.exec('BEGIN');
  try {
    db.exec(SCHEMA);
    const out = {
      family_daily: buildDaily(db),
      family_written: buildWritten(db, today),
      family_units: buildUnits(db),
    };
    out.family_ratings = buildRatings(db, today);
    Object.assign(out, buildKpis(db));
    const meta = db.prepare('INSERT INTO kpi_meta VALUES (?, ?)');
    meta.run('rebuilt_at', new Date().toISOString());
    meta.run('vc_count_markets', VC_COUNT_MARKETS.join(','));
    db.exec('COMMIT');
    return out;
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// One snapshot per family per VC ratings day (from its smallest ASIN present that day).
function buildDaily(db) {
  const rows = db.prepare(`SELECT f.family_id, v.ratings_date day, v.rating_count c, v.raw_rating s
    FROM vc_ratings_daily v JOIN asin_family f ON f.asin = v.asin
    WHERE v.rating_count IS NOT NULL
    ORDER BY f.family_id, v.ratings_date, v.asin`).all();
  const ins = db.prepare(`INSERT OR IGNORE INTO family_daily VALUES (?,?,?,?,?,?,?,?,?)`);
  let prev = null, n = 0;
  for (const r of rows) {
    if (prev && prev.family_id === r.family_id && prev.day === r.day) continue; // one per day
    const p = prev && prev.family_id === r.family_id ? prev : null;
    ins.run(r.family_id, r.day, r.c, r.s, p?.day ?? null, p?.c ?? null, p?.s ?? null,
      p ? daysBetween(p.day, r.day) : null, p ? r.c - p.c : null);
    prev = r; n++;
  }
  return n;
}

// Last day Seller Central covers, per marketplace: the day before the newest
// successful pull of any view of that marketplace (reviews dated after that
// can still arrive). Late reviews get added on the next rebuild.
function coveredThrough(db) {
  const out = {};
  for (const r of db.prepare(`SELECT vr.view, MAX(r.started_at) at FROM view_runs vr JOIN runs r ON r.id = vr.run_id
    WHERE vr.status = 'ok' GROUP BY vr.view`).all()) {
    const code = r.view.split('|')[1];
    const day = addDays(new Date(r.at).toLocaleDateString('en-CA'), -1);
    if (!out[code] || day < out[code]) out[code] = day; // the least covered view of that marketplace
  }
  // Before views existed, runs were Lifepro US only.
  if (!out.US) {
    const r = db.prepare(`SELECT MAX(started_at) at FROM runs WHERE status = 'ok'`).get();
    if (r?.at) out.US = addDays(new Date(r.at).toLocaleDateString('en-CA'), -1);
  }
  return out;
}

function buildWritten(db, today) {
  const cover = coveredThrough(db);
  const reviews = db.prepare(`SELECT f.family_id, r.review_date d, r.marketplace m, r.rating, r.missing_since
    FROM reviews r JOIN asin_family f ON f.asin = r.child_asin WHERE r.review_date IS NOT NULL`).all();
  const agg = new Map();
  for (const r of reviews) {
    for (const kind of ['day', 'week', 'month']) {
      const [s, e] = periodOf(kind, r.d);
      const k = `${r.family_id}|${kind}|${s}|${r.m}`;
      let a = agg.get(k);
      if (!a) agg.set(k, (a = { f: r.family_id, kind, s, e, m: r.m, n: 0, stars: 0, low: 0, gone: 0 }));
      a.n++; a.stars += r.rating ?? 0; if (r.rating && r.rating <= 2) a.low++; if (r.missing_since) a.gone++;
    }
  }
  const ins = db.prepare('INSERT INTO family_written VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  for (const a of agg.values()) {
    const c = cover[a.m] ?? null;
    ins.run(a.f, a.kind, a.s, a.e, a.m, a.n, a.stars, a.low, a.gone, c && a.e <= c ? 1 : 0, c);
  }
  return agg.size;
}

function buildUnits(db) {
  // newest copy of each ASIN's numbers for each week / month
  return Number(db.prepare(`INSERT INTO family_units
    SELECT f.family_id, u.period_kind, u.period_start, u.period_end,
           SUM(u.shipped_units), SUM(u.ordered_units), COUNT(*), 'vc', MIN(u.complete)
    FROM vc_units u JOIN asin_family f ON f.asin = u.asin
    WHERE u.period_kind IN ('week', 'month')
      AND u.pull_id = (SELECT MAX(u2.pull_id) FROM vc_units u2 WHERE u2.asin = u.asin
                        AND u2.period_kind = u.period_kind AND u2.period_start = u.period_start)
    GROUP BY f.family_id, u.period_kind, u.period_start`).run().changes);
}

function buildRatings(db, today) {
  const daily = new Map();
  for (const r of db.prepare('SELECT * FROM family_daily ORDER BY family_id, day').all()) {
    if (!daily.has(r.family_id)) daily.set(r.family_id, []);
    daily.get(r.family_id).push(r);
  }
  if (!daily.size) return 0;
  const { vcFrom, vcTo } = db.prepare('SELECT MIN(day) vcFrom, MAX(day) vcTo FROM family_daily').get();
  const markets = VC_COUNT_MARKETS.map(() => '?').join(',');
  const writtenQ = db.prepare(`SELECT SUM(written) n, SUM(stars_sum) stars, MIN(complete) complete, MIN(covered_through) cov
    FROM family_written WHERE family_id = ? AND period_kind = ? AND period_start = ? AND marketplace IN (${markets})`);
  const removedQ = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(r.rating), 0) stars FROM reviews r JOIN asin_family f ON f.asin = r.child_asin
    WHERE f.family_id = ? AND r.marketplace IN (${markets}) AND date(r.missing_since) BETWEEN ? AND ?`);
  const coverAll = db.prepare(`SELECT MIN(covered_through) c FROM family_written WHERE marketplace IN (${markets})`).get()?.c;
  const ins = db.prepare(`INSERT INTO family_ratings VALUES (${Array(24).fill('?').join(',')})`);
  // newest snapshot on or before day, no older than MAX_GAP_DAYS. Only once
  // Vendor Central has data for that day at all: before that, wait for it
  // (VC ratings arrive about 3 days late) instead of using an older snapshot.
  const at = (list, day) => {
    if (vcTo < day) return null;
    let best = null;
    for (const r of list) { if (r.day <= day) best = r; else break; }
    return best && daysBetween(best.day, day) <= MAX_GAP_DAYS ? best : null;
  };
  let n = 0;
  for (const kind of ['week', 'month']) {
    for (const [s, e] of periodsBetween(kind, addDays(vcFrom, 1), today)) {
      for (const [fam, list] of daily) {
        const a = at(list, addDays(s, -1));
        const b = at(list, e);
        const why = [];
        if (e >= today) why.push('period not over');
        const vcWhy = (day) => (vcTo < day ? `waiting for VC ratings of ${day}` : `no VC snapshot for ${day}`);
        if (!a) why.push(vcWhy(addDays(s, -1)));
        if (!b) why.push(vcWhy(e));
        else if (b.day !== e && e < today) why.push(`end uses ${b.day} snapshot`);
        if (a && a.day !== addDays(s, -1)) why.push(`start uses ${a.day} snapshot`);
        const w = writtenQ.get(fam, kind, s, ...VC_COUNT_MARKETS);
        const written = w?.n ?? 0, wStars = w?.stars ?? 0;
        // no written reviews in the period: complete as soon as SC covers the period end
        const scDone = w?.n ? w.complete === 1 : coverAll != null && e <= coverAll;
        if (!scDone) why.push('written reviews not pulled for the whole period yet');
        const rem = removedQ.get(fam, ...VC_COUNT_MARKETS, s, e);
        let rises = 0, drops = 0;
        for (const r of list) if (r.day >= s && r.day <= e && r.count_change != null) { if (r.count_change > 0) rises += r.count_change; else drops += r.count_change; }
        const newRatings = a && b ? b.rating_count - a.rating_count : null;
        const starOnly = newRatings == null ? null : newRatings - written + rem.n;
        const newStars = a && b ? b.rating_count * b.raw_rating - a.rating_count * a.raw_rating : null;
        const err = a && b ? 0.005 * (a.rating_count + b.rating_count) : null;
        const starOnlyStars = newStars == null ? null : newStars + rem.stars - wStars;
        const blocking = why.filter((x) => !/uses .* snapshot/.test(x));
        ins.run(fam, kind, s, e, a?.day ?? null, a?.rating_count ?? null, a?.raw_rating ?? null,
          b?.day ?? null, b?.rating_count ?? null, b?.raw_rating ?? null,
          newRatings, written, rem.n, starOnly, rises, drops, round(newStars, 2),
          newRatings > 0 ? round(newStars / newRatings, 2) : null,
          written > 0 ? round(wStars / written, 2) : null,
          starOnly > 0 ? round(starOnlyStars / starOnly, 2) : null,
          newRatings > 0 ? round(err / newRatings, 2) : null,
          starOnly > 0 ? round(err / starOnly, 2) : null,
          blocking.length ? 0 : 1, why.join('; ') || null);
        n++;
      }
    }
  }
  return n;
}

function buildKpis(db) {
  const prevStart = (kind, s) => periodOf(kind, addDays(s, -1))[0];
  const units = new Map();
  for (const u of db.prepare(`SELECT family_id, period_kind, period_start, SUM(shipped) shipped, SUM(ordered) ordered,
      MIN(complete) complete FROM family_units GROUP BY 1, 2, 3`).all()) units.set(`${u.family_id}|${u.period_kind}|${u.period_start}`, u);
  const brandOf = new Map(db.prepare(`SELECT family_id, MAX(brand) brand FROM asin_family GROUP BY 1`).all().map((r) => [r.family_id, r.brand]));
  const ins = db.prepare(`INSERT INTO kpi_family VALUES (${Array(15).fill('?').join(',')})`);
  const per = (x, u) => (u > 0 && x != null ? round(x / u, 5) : null);
  let n = 0;
  const brand = new Map();
  for (const r of db.prepare('SELECT * FROM family_ratings').all()) {
    for (const basis of ['shipped', 'ordered', 'shipped prev period', 'ordered prev period']) {
      const prev = basis.endsWith('prev period');
      const u = units.get(`${r.family_id}|${r.period_kind}|${prev ? prevStart(r.period_kind, r.period_start) : r.period_start}`);
      const col = basis.startsWith('shipped') ? 'shipped' : 'ordered';
      const nUnits = u?.[col] ?? null;
      const why = [r.why_not, !u ? 'no units for this family and period' : u.complete ? null : 'units not final yet']
        .filter(Boolean).join('; ') || null;
      const complete = r.complete && u && u.complete ? 1 : 0;
      const total = r.new_ratings;
      ins.run(r.family_id, brandOf.get(r.family_id) ?? null, r.period_kind, r.period_start, r.period_end, basis,
        nUnits, r.written, r.star_only, total, per(r.written, nUnits), per(r.star_only, nUnits), per(total, nUnits), complete, why);
      n++;
      if (complete) {
        for (const b of [brandOf.get(r.family_id) ?? '(no brand)', 'All brands']) {
          const k = `${b}|${r.period_kind}|${r.period_start}|${basis}`;
          let a = brand.get(k);
          if (!a) brand.set(k, (a = { b, kind: r.period_kind, s: r.period_start, e: r.period_end, basis, fam: 0, units: 0, w: 0, so: 0, t: 0, stars: 0 }));
          a.fam++; a.units += nUnits ?? 0; a.w += r.written; a.so += r.star_only; a.t += total; a.stars += r.new_stars_sum ?? 0;
        }
      }
    }
  }
  const insB = db.prepare(`INSERT INTO kpi_brand VALUES (${Array(14).fill('?').join(',')})`);
  for (const a of brand.values()) {
    insB.run(a.b, a.kind, a.s, a.e, a.basis, a.fam, a.units, a.w, a.so, a.t,
      per(a.w, a.units), per(a.so, a.units), per(a.t, a.units), a.t > 0 ? round(a.stars / a.t, 2) : null);
  }
  return { kpi_family: n, kpi_brand: brand.size };
}
