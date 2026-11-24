// "Latest data available": one line per data type, for the emails and
// "npm run status". Shows how fresh each source is and up to which day the
// sources can be combined.
import { loadViews, viewKey, viewName } from './views.js';

const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-CA') : null); // local YYYY-MM-DD

export function dataDates(db) {
  const rows = [];
  const views = loadViews().views.filter((v) => v.enabled);

  // Written reviews (Seller Central), per view.
  const lastOk = new Map(db.prepare(`SELECT v.view, MAX(r.started_at) at FROM view_runs v JOIN runs r ON r.id = v.run_id
    WHERE v.status = 'ok' GROUP BY v.view`).all().map((x) => [x.view, x.at]));
  const newest = new Map(db.prepare(`SELECT store || '|' || marketplace k, MAX(review_date) d FROM reviews GROUP BY k`)
    .all().map((x) => [x.k, x.d]));
  // Runs from before view_runs existed only pulled LIFEPRO OUTLET / US.
  if (!lastOk.has('LIFEPRO OUTLET|US')) {
    const old = db.prepare(`SELECT MAX(started_at) at FROM runs WHERE status = 'ok'
      AND id NOT IN (SELECT run_id FROM view_runs)`).get()?.at;
    if (old) lastOk.set('LIFEPRO OUTLET|US', old);
  }
  const pulledDays = [];
  for (const v of views) {
    const at = lastOk.get(viewKey(v));
    if (at) pulledDays.push(day(at));
    rows.push({ what: `Written reviews, ${viewName(v)}`, source: 'Seller Central', latest: newest.get(viewKey(v)) ?? null,
      pulled: day(at), note: at ? 'newest review date' : 'not pulled yet' });
  }

  // Vendor Central.
  const vc = db.prepare(`SELECT MAX(ratings_date) ratings, MAX(units_date) units, MAX(started_at) at
    FROM vc_pulls WHERE status = 'ok'`).get() || {};
  rows.push({ what: 'Review count + star rating', source: 'Vendor Central', latest: vc.ratings ?? null,
    pulled: day(vc.at), note: vc.ratings ? "Amazon's refresh date" : 'not pulled yet' });
  rows.push({ what: 'Units (ordered / shipped)', source: 'Vendor Central', latest: vc.units ?? null,
    pulled: day(vc.at), note: vc.units ? "Amazon's refresh date" : 'not pulled yet' });
  for (const [kind, label] of [['week', 'Units, newest full week'], ['month', 'Units, newest full month']]) {
    const u = db.prepare(`SELECT u.period_start s, u.period_end e, MAX(p.started_at) at FROM vc_units u
      JOIN vc_pulls p ON p.id = u.pull_id WHERE u.period_kind = ? AND u.complete = 1
      GROUP BY s, e ORDER BY e DESC LIMIT 1`).get(kind);
    rows.push({ what: label, source: 'Vendor Central', latest: u?.e ?? null, pulled: day(u?.at),
      note: u ? `${u.s} to ${u.e}` : 'not pulled yet' });
  }

  // Star-only ratings need both: the count and the written reviews up to the same day.
  const sc = pulledDays.length === views.length && pulledDays.length ? pulledDays.sort()[0] : null;
  const both = sc && vc.ratings ? [sc, vc.ratings].sort()[0] : null;
  rows.push({ what: 'Star-only ratings (count change − written)', source: 'Both', latest: both,
    pulled: null, note: both ? 'can be worked out up to this day' : 'needs both sources' });
  return rows;
}

export const STATUS_HEAD = ['Data', 'Source', 'Latest day', 'Last pulled', 'Note'];
export const statusRows = (db) => dataDates(db).map((r) => [r.what, r.source, r.latest ?? '-', r.pulled ?? '-', r.note]);
