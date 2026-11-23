// Rebuilds the review families and all KPI tables from the raw pulls (the
// pulls and the morning check do this by themselves) and prints a summary.
//   npm run kpi
import { openDb } from './lib/db.js';
import { rebuildKpis } from './lib/kpi.js';

const db = openDb();
const n = rebuildKpis(db);
console.log('Rows per table:'); console.table(n);
const q = (sql) => db.prepare(sql).all();
console.log('Complete weeks and months per table:');
console.table(q(`SELECT 'family_ratings' tbl, period_kind, SUM(complete) complete, COUNT(*) rows, MAX(CASE WHEN complete THEN period_start END) newest_complete FROM family_ratings GROUP BY 2
  UNION ALL SELECT 'family_units', period_kind, SUM(complete), COUNT(*), MAX(CASE WHEN complete THEN period_start END) FROM family_units GROUP BY 2
  UNION ALL SELECT 'kpi_family', period_kind, SUM(complete), COUNT(*), MAX(CASE WHEN complete THEN period_start END) FROM kpi_family GROUP BY 2`));
console.log('Most common reasons a week is not complete yet:');
console.table(q(`SELECT why_not, COUNT(*) families FROM family_ratings WHERE complete = 0 AND period_kind = 'week' GROUP BY 1 ORDER BY 2 DESC LIMIT 5`));
db.close();
