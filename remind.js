// Evening check (every day at 6pm by the schedule), so problems get fixed
// tonight instead of being found in the morning:
//   1. Is the Mac plugged in?
//   2. Is Vendor Central still signed in? (daily pull at 6:00am)
//   3. Before a Seller Central pull day (Monday, Tuesday): is Seller Central signed in?
// The pages are opened out of sight.
//
// Emails: always the evening before a Seller Central pull ("all good" or
// "fix tonight"). Other evenings: only if something needs fixing.
//   npm run remind            (add --force to email even when all is good)
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { openBrowser, needsLogin, sleep } from './lib/browser.js';
import { notify } from './lib/notify.js';
import { config } from './lib/config.js';
import { takeLock } from './lib/lock.js';
import { loadViews, pickViews, viewName } from './lib/views.js';

const force = process.argv.includes('--force');
const tomorrow = new Date(Date.now() + 864e5);
const dayName = tomorrow.toLocaleDateString('en-US', { weekday: 'long' });
const scViews = pickViews(loadViews(), [], tomorrow);
const scTomorrow = scViews.length > 0;

let batt = '';
try { batt = execFileSync('pmset', ['-g', 'batt'], { encoding: 'utf8' }); } catch {}
const plugged = batt ? /AC Power/.test(batt) : null;
const battery = batt.match(/(\d+)%/)?.[1] ?? '?';

async function isSignedIn(url, profileDir) {
  try {
    const { context, page } = await openBrowser({ headless: true, profileDir });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(3000);
    const out = !(await needsLogin(page)) && new URL(page.url()).host === new URL(url).host;
    await context.close();
    return out;
  } catch { return null; }
}

const release = await takeLock('Evening check', { maxWaitMin: 20 });
const vc = await isSignedIn(config.vcUrl, config.vcProfileDir);
const sc = scTomorrow ? await isSignedIn(config.reviewsUrl, config.profileDir) : 'not needed';
release?.();

const problems = [];
if (plugged === false) problems.push(`NOT plugged in (battery ${battery}%). The Mac must be plugged in, lid open, to wake at 6:00am.`);
if (vc === false) problems.push("Vendor Central signed out. Tomorrow's daily review count would be lost.");
if (vc === null) problems.push("Couldn't check Vendor Central (no internet?).");
if (sc === false) problems.push(`Seller Central signed out. Tomorrow's review pull (${scViews.map(viewName).join(', ')}) would fail.`);
if (sc === null) problems.push("Couldn't check Seller Central (no internet?).");
const signedOut = vc === false || sc === false;

// On days without a Seller Central pull, don't nag about power alone.
const worthEmail = scTomorrow || force || signedOut || vc === null;
if (!worthEmail) {
  console.log(problems.length ? `Not emailed: ${problems.join(' ')}` : 'All good.');
  process.exit(0);
}

const tomorrowLine = scTomorrow
  ? `Tomorrow (${dayName}) at 6:00am this Mac pulls the Amazon written reviews (${scViews.map(viewName).join(', ')}) and the daily Vendor Central review counts.`
  : `Tomorrow (${dayName}) at 6:00am this Mac pulls the daily Vendor Central review counts.`;
const text = problems.length
  ? [tomorrowLine, '', 'FIX TONIGHT', ...problems.map((p) => `  - ${p}`),
      ...(signedOut ? ['', 'TO SIGN IN (2 minutes, on the Mac)',
        '  1. Double-click "Amazon Sign In" on the Desktop.',
        '  2. Chrome opens only for what is signed out. Type your password and code there.',
        '     The window closes by itself when you are in.'] : []),
      ...(plugged === false ? ['', 'POWER', '  Plug the Mac in and leave the lid open tonight.'] : [])]
  : [tomorrowLine, '', '  - Plugged in: yes', '  - Vendor Central signed in: yes',
      ...(scTomorrow ? ['  - Seller Central signed in: yes'] : []), '', 'Leave the Mac plugged in with the lid open tonight.'];
text.push('', 'ABOUT THIS EMAIL',
  "An evening check from the Amazon reviews project on this Mac. It checks that tomorrow's",
  'morning pulls can run: power, and that the saved Amazon sign-ins still work.',
  `Project folder: ${path.dirname(config.root)}`);

await notify({
  title: problems.length ? "FIX TONIGHT before tomorrow's 6:00am pull" : `${dayName} 6:00am pulls, all good`,
  short: problems.length ? problems.join(' ') : 'Plugged in, signed in. Leave the lid open.',
  emailText: text.join('\n'),
  kind: 'remind',
});
console.log(problems.length ? problems.join('\n') : 'All good.');
