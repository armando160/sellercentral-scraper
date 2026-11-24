// Opens Chrome so YOU sign in to Seller Central (password + OTP).
// The script never sees or types your password. The session is saved in
// .browser-profile/ and used by every pull until Amazon signs it out.
//   npm run login                 Seller Central US
//   npm run login -- --site=UK    another site from views.json "sites" (UK, SA, TR)
// Easier: "npm run signin" (the Desktop "Amazon Sign In") checks every site.
import { openBrowser, needsLogin, waitForEnter } from './lib/browser.js';
import { loadViews, siteUrl, siteName } from './lib/views.js';

const site = (process.argv.find((a) => a.startsWith('--site='))?.slice(7) || 'NA').toUpperCase();
const data = loadViews();
const { context, page } = await openBrowser({ headless: false });
await page.goto(siteUrl(data, site), { waitUntil: 'domcontentloaded' });

console.log('\nA Chrome window opened.');
console.log(`1. Sign in to ${siteName(data, site)}.`);
console.log('2. Tick "Keep me signed in" and "Don\'t require OTP on this browser" if offered.');
console.log(`3. If asked, pick the account${site === 'NA' ? ' and United States' : ''}.`);
console.log('4. Wait until you see the Customer Reviews list.');
await waitForEnter('\nPress Enter here when the reviews list is showing... ');

if (await needsLogin(page)) {
  console.log(`\nStill on a sign-in page. Run "npm run login${site === 'NA' ? '' : ` -- --site=${site}`}" again.`);
  process.exitCode = 2;
} else {
  console.log(`\nSigned in and saved (${page.url().split('/')[2]}). You can run: npm run pull`);
}
await context.close();
