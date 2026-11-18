// Opens Chrome so YOU sign in to Seller Central (password + OTP).
// The script never sees or types your password. The session is saved in
// .browser-profile/ and used by every pull until Amazon signs it out.
import { openBrowser, needsLogin, waitForEnter } from './lib/browser.js';
import { config } from './lib/config.js';

const { context, page } = await openBrowser({ headless: false });
await page.goto(config.reviewsUrl, { waitUntil: 'domcontentloaded' });

console.log('\nA Chrome window opened.');
console.log('1. Sign in to Seller Central.');
console.log('2. Tick "Keep me signed in" and "Don\'t require OTP on this browser" if offered.');
console.log('3. If asked, pick the account and United States.');
console.log('4. Wait until you see the Customer Reviews list.');
await waitForEnter('\nPress Enter here when the reviews list is showing... ');

if (await needsLogin(page)) {
  console.log('\nStill on a sign-in page. Run "npm run login" again.');
  process.exitCode = 2;
} else {
  console.log('\nSigned in and saved. You can run: npm run pull');
}
await context.close();
