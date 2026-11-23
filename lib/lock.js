// One browser job at a time on this Mac. The Seller Central pull, the Vendor
// Central pull and the sign-in helper all take this lock, so two Chromes
// never click Amazon at the same moment (and a profile is never opened twice).
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { sleep } from './browser.js';

const FILE = path.join(path.dirname(config.dbPath), '.browser.lock');

function holder() {
  try {
    const h = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    process.kill(h.pid, 0); // throws if that process is gone
    return h;
  } catch { return null; }
}

// Waits up to maxWaitMin for the other job to finish. Returns a release
// function, or null if it's still busy after that.
export async function takeLock(name, { maxWaitMin = 45, log = console.log } = {}) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const until = Date.now() + maxWaitMin * 60000;
  let told = false;
  for (;;) {
    const h = holder();
    if (!h || h.pid === process.pid) break;
    if (Date.now() > until) return null;
    if (!told) { log(`Waiting: "${h.name}" is using the browser (since ${h.at}).`); told = true; }
    await sleep(15000);
  }
  fs.writeFileSync(FILE, JSON.stringify({ pid: process.pid, name, at: new Date().toISOString() }));
  const release = () => { try { if (holder()?.pid === process.pid) fs.unlinkSync(FILE); } catch {} };
  process.on('exit', release);
  return release;
}
