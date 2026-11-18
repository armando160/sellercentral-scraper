// Tells you how a run went: Mac notification always, Telegram if set up,
// and a healthchecks.io ping (so you get emailed if the Mac never ran it).
import { execFile } from 'node:child_process';
import { getSecret } from './secrets.js';

function macNotify(title, text) {
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

// ok=true pings the success URL; ok=false pings /fail so you get alerted.
export async function healthcheck(ok) {
  const url = getSecret('healthcheck-url', { required: false });
  if (!url) return;
  await fetch(ok ? url : `${url.replace(/\/$/, '')}/fail`, { method: 'POST' }).catch(() => {});
}

export async function notify(title, text) {
  if (process.env.NO_NOTIFY === '1') return; // tests
  await Promise.all([macNotify(title, text), telegram(`${title}\n${text}`)]);
}
