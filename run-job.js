// Started by the schedule (launchd) for each job:  node run-job.js vc|pull|check
//
// Why node and not a shell script: macOS protects the Documents folder. A shell
// started by the schedule is NOT allowed to open files here (the 23 Nov 6:00am
// pulls failed with "can't open input file"), but node is. So the schedule
// starts node, and node does what the old run-*.sh scripts did:
//   - keeps the Mac awake while the job runs (caffeinate)
//   - writes the output to logs/<job>-<date>.log
//   - vc waits 1 minute first, so on pull days Seller Central takes the browser first
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const JOBS = {
  vc: { script: 'vc-pull.js', log: 'vc', waitSec: 60 },
  pull: { script: 'scrape.js', log: 'pull' },
  check: { script: 'check.js', log: 'check' },
};
const job = JOBS[process.argv[2]];
if (!job) { console.error(`Usage: node run-job.js ${Object.keys(JOBS).join('|')}`); process.exit(2); }

const dir = path.dirname(fileURLToPath(import.meta.url));
fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
const day = new Date().toLocaleDateString('en-CA');
const out = fs.openSync(path.join(dir, 'logs', `${job.log}-${day}.log`), 'a');
const env = { ...process.env, PATH: `${path.dirname(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? '/usr/bin:/bin'}` };

if (job.waitSec) await new Promise((r) => setTimeout(r, job.waitSec * 1000));
const awake = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
const r = spawnSync(process.execPath, [job.script], { cwd: dir, env, stdio: ['ignore', out, out] });
awake.kill();
process.exit(r.status ?? 1);
