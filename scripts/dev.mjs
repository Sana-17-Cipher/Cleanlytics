/**
 * Starts the whole app: the Python analysis API and the Next front end.
 *
 * The front end is useless without the API — every screen reads from it — but
 * `next dev` only ever started the front end, so forgetting the API showed up
 * as "Could not reach the analysis service" rather than as an obvious missing
 * process. This runs both, labels their output, and shuts both down together.
 *
 * Uses nothing but Node built-ins on purpose: no extra dependency to install.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND = path.join(ROOT, 'backend');
const isWindows = process.platform === 'win32';

/**
 * Prefer the backend's own virtualenv. Falling back to a bare `python` is
 * deliberate: it fails with a readable ImportError rather than silently doing
 * nothing if the venv has not been created yet.
 */
function pythonExecutable() {
  const venv = isWindows
    ? path.join(BACKEND, 'venv', 'Scripts', 'python.exe')
    : path.join(BACKEND, 'venv', 'bin', 'python');
  if (existsSync(venv)) return venv;
  console.warn(`[dev] No virtualenv at ${venv} — falling back to "python" on PATH.`);
  return isWindows ? 'python' : 'python3';
}

const children = new Map();

/** Spawns one process and tags every line it prints so the two logs stay readable. */
function start(label, command, args, cwd) {
  const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  children.set(label, child);

  const relay = (stream, target) => {
    let carry = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      const lines = (carry + chunk).split('\n');
      carry = lines.pop() ?? '';
      for (const line of lines) target.write(`[${label}] ${line}\n`);
    });
    stream.on('end', () => {
      if (carry) target.write(`[${label}] ${carry}\n`);
    });
  };
  relay(child.stdout, process.stdout);
  relay(child.stderr, process.stderr);

  child.on('error', (error) => {
    console.error(`[dev] Could not start ${label}: ${error.message}`);
    shutdown(1);
  });

  // If either half dies the other is not useful on its own, so take both down
  // instead of leaving a half-running app that fails in confusing ways.
  child.on('exit', (code, signal) => {
    children.delete(label);
    if (shuttingDown) return;
    console.error(`[dev] ${label} exited (${signal ?? `code ${code}`}). Stopping the rest.`);
    shutdown(code ?? 1);
  });

  return child;
}

let shuttingDown = false;

/**
 * Windows needs `taskkill /T` because uvicorn's reloader runs the real server
 * in a grandchild process, which a plain kill on the parent would orphan.
 */
function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const [label, child] of children) {
    if (child.pid === undefined) continue;
    if (isWindows) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
    children.delete(label);
  }

  // Give the kills a moment to land before the parent disappears.
  setTimeout(() => process.exit(exitCode), 500);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

start('api', pythonExecutable(), ['main.py'], BACKEND);
start('web', process.execPath, [path.join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next'), 'dev'], ROOT);

console.log('[dev] api -> http://127.0.0.1:8008   web -> http://localhost:3000   (Ctrl+C stops both)');
