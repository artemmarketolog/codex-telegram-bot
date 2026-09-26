import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execute = promisify(execFile);
const binary = process.env.CODEX_BIN || 'codex';

async function runCodex(action) {
  let stdout;
  try {
    ({ stdout } = await execute(binary, ['app-server', 'daemon', action], {
      encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
    }));
  } catch (error) {
    // Since Codex 0.157 `version` exits with an error instead of reporting notRunning when no daemon is up.
    if (action === 'version' && /failed to connect/i.test(`${error.stderr ?? ''}${error.stdout ?? ''}`)) return { status: 'notRunning' };
    throw new Error(`Codex daemon ${action} command failed`);
  }
  try { return JSON.parse(stdout); }
  catch { throw new Error(`Codex daemon ${action} returned invalid status JSON`); }
}

// Starts only an absent daemon; never restarts, stops, updates or kills a running one.
export async function ensureDaemon({ statusOnly = false, run = runCodex } = {}) {
  let status = await run('version');
  if (status.status === 'running') return { status: 'running', action: 'none', version: status.appServerVersion };
  if (status.status !== 'notRunning') throw new Error('Codex daemon returned an unrecognized state; no action taken');
  if (statusOnly) return { status: 'notRunning', action: 'none' };
  await run('start');
  status = await run('version');
  if (status.status !== 'running') throw new Error('Codex daemon start did not produce a running daemon');
  return { status: 'running', action: 'started', version: status.appServerVersion };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Under journald a healthy tick is silent; real actions log at notice, failures at err.
  const journal = Boolean(process.env.JOURNAL_STREAM);
  try {
    const result = await ensureDaemon({ statusOnly: process.argv.includes('--status') });
    if (!journal || result.action !== 'none') console.log(`${journal ? '<5>' : ''}${JSON.stringify(result)}`);
  } catch (error) {
    console.error(`${journal ? '<3>' : ''}${JSON.stringify({ status: 'error', message: error.message })}`);
    process.exitCode = 1;
  }
}
