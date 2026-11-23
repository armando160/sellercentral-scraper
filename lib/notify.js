// Tells you how things went:
//   - email (through the Google Sheet's Apps Script, to EMAIL_TO in Code.gs)
//   - Mac notification
//   - Telegram, if set up
//   - healthchecks.io ping, if set up
import { execFile } from 'node:child_process';
import { getSecret } from './secrets.js';

function macNotify(title, text) {
  if (process.env.NO_MAC_NOTIFY === '1') return Promise.resolve(); // tests
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return new Promise((resolve) =>
    execFile('osascript', ['-e', `display notification "${esc(text)}" with title "${esc(title)}" sound name "Glass"`], () => resolve()));
}

async function telegram(text) {
  const token = getSecret('telegram-token', { required: false });
  const chat = getSecret('telegram-chat', { required: false });
  if (!token || !chat) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text }),
  }).catch(() => {});
}

// kind 'pull' also tells Google the Monday run happened (missed-run check).
async function email(subject, text, kind, html) {
  const url = getSecret('sheets-url', { required: false });
  const token = getSecret('sheets-token', { required: false });
  if (!url || !token) return false;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, email: { subject, text, kind, html } }),
    });
    const out = JSON.parse(await res.text());
    return out.ok === true && out.emailed === true;
  } catch {
    return false;
  }
}

// ok=true pings the success URL; ok=false pings /fail so you get alerted.
export async function healthcheck(ok) {
  const url = getSecret('healthcheck-url', { required: false });
  if (!url) return;
  await fetch(ok ? url : `${url.replace(/\/$/, '')}/fail`, { method: 'POST' }).catch(() => {});
}

// title/short go to the Mac and Telegram; the email gets the long text.
export async function notify({ title, short, emailText, emailHtml, kind, statusFirst = false }) {
  // statusFirst: the subject starts with the status ("OK: ...", "PROBLEM, open now: ..."),
  // so it can be read in the inbox list without opening the email.
  const subject = statusFirst ? `${title} - Amazon reviews` : `Amazon reviews: ${title}`;
  if (process.env.NOTIFY_DRY) { console.log(`[not sent] ${subject}\n${emailText ?? short}`); return; }
  if (process.env.NO_NOTIFY === '1') return { emailed: false }; // tests
  const [emailed] = await Promise.all([
    email(subject, emailText ?? short, kind, emailHtml),
    macNotify(`Amazon reviews: ${title}`, short),
    telegram(`Amazon reviews: ${title}\n${short}`),
  ]);
  if (!emailed) await macNotify('Amazon reviews: email failed', 'Could not send the status email. Check the Sheets web app.');
  return { emailed };
}
