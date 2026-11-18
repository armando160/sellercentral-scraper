// Quick check on this Mac: monthly numbers, missing fields, last runs.
//   npm run stats
import { openDb } from './lib/db.js';

const db = openDb();
const q = (sql) => db.prepare(sql).all();

console.log('Reviews:', q('SELECT COUNT(*) n FROM reviews')[0].n,
  ' Parent ASINs:', q('SELECT COUNT(DISTINCT parent_asin) n FROM reviews')[0].n,
  ' Not yet in Sheets:', q('SELECT COUNT(*) n FROM reviews WHERE uploaded_at IS NULL OR changed_at > uploaded_at')[0].n);
console.log('Date range:', { ...q('SELECT MIN(review_date) oldest, MAX(review_date) newest FROM reviews')[0] });

console.log('\nReviews per month (the first month is partial):');
console.table(q(`SELECT substr(review_date, 1, 7) month, COUNT(*) reviews,
  SUM(rating = 1) "1★", SUM(rating = 2) "2★", SUM(rating = 3) "3★", SUM(rating = 4) "4★", SUM(rating = 5) "5★",
  ROUND(AVG(rating), 2) avg_stars FROM reviews GROUP BY month ORDER BY month`));

console.log('Missing fields (should all be 0):');
console.table(q(`SELECT SUM(parent_asin IS NULL) no_parent, SUM(child_asin IS NULL) no_child,
  SUM(rating IS NULL) no_rating, SUM(body IS NULL) no_text, SUM(review_date IS NULL) no_date FROM reviews`));

console.log('Last 10 runs:');
console.table(q(`SELECT id, substr(started_at, 1, 16) started, status, pages, seen, new_reviews,
  low_star_new, amazon_total, uploaded, substr(note, 1, 50) note FROM runs ORDER BY id DESC LIMIT 10`));
db.close();
