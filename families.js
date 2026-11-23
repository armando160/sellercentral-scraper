// Rebuilds the review families from the Vendor Central data (vc-pull.js does
// this after every pull) and prints a summary.
//   npm run families
import { openDb } from './lib/db.js';
import { rebuildFamilies } from './lib/families.js';

const db = openDb();
const f = rebuildFamilies(db);
console.log(`${f.asins} ASINs in ${f.families} review families.\n`);
const q = (sql) => db.prepare(sql).all();
console.table(q(`SELECT confidence, COUNT(DISTINCT family_id) families, COUNT(*) asins FROM asin_family GROUP BY 1`));
console.log('Written reviews matched to a family:');
console.table(q(`SELECT sheet_brand brand, marketplace, confidence AS matched_by, COUNT(*) reviews, COUNT(DISTINCT child_asin) asins
  FROM review_family GROUP BY 1, 2, 3 ORDER BY 1, 2, 4 DESC`));
db.close();
