// Opens Chrome so YOU sign in to Vendor Central. The script never sees or
// types your password or codes. The session is saved in .browser-profile-vc/.
//
// While the window is open it also records, for building the export script:
// what the page loads (its own data responses), the page itself and a
// screenshot, into discovery/vc/ (git-ignored, stays on this Mac).
import fs from 'node:fs';
import path from 'node:path';
import { openBrowser, needsLogin, waitForEnter } from './lib/browser.js';
import { config } from './lib/config.js';

const out = path.join(config.root, 'discovery', 'vc');
fs.mkdirSync(path.join(out, 'net'), { recursive: true });

const { context, page } = await openBrowser({ headless: false, profileDir: config.vcProfileDir });
let n = 0;
page.on('response', async (res) => {
  try {
    const url = res.url();
    const type = res.headers()['content-type'] || '';
    if (!/vendorcentral\.amazon\.com/.test(url) || !/json/.test(type)) return;
    const body = await res.text();
    if (/password|otp|token/i.test(url)) return; // never keep sign-in traffic
    fs.writeFileSync(path.join(out, 'net', `${String(++n).padStart(3, '0')}.json`),
      JSON.stringify({ url, status: res.status(), at: new Date().toISOString(), body }, null, 1));
  } catch { /* page navigated away */ }
});
await page.goto(config.vcUrl, { waitUntil: 'domcontentloaded' });

console.log('\nA Chrome window opened.');
console.log('1. Sign in to Vendor Central (tick "Keep me signed in" if offered).');
console.log('2. Wait until the dashboard table is showing.');
console.log('3. Optional, helps a lot: click the (i) next to "Customer review count",');
console.log('   "Raw star ratings" and "Ordered Units", and open the Time period box once.');
await waitForEnter('\nPress Enter here when the table is showing... ');

if (await needsLogin(page)) {
  console.log('\nStill on a sign-in page. Run "npm run vc-login" again.');
  process.exitCode = 2;
} else {
  fs.writeFileSync(path.join(out, 'page.html'), await page.content());
  fs.writeFileSync(path.join(out, 'page.txt'), await page.locator('body').innerText().catch(() => ''));
  await page.screenshot({ path: path.join(out, 'page.png'), fullPage: true }).catch(() => {});
  console.log(`\nSigned in and saved. Page notes saved (${n} data responses).`);
}
await context.close();
