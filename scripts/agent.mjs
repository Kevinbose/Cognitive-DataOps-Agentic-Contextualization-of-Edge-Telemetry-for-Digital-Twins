#!/usr/bin/env node
/**
 * Run the diagnosis agent (services/agent) with its own virtual environment.
 *
 *   node scripts/agent.mjs          start the agent on 127.0.0.1:8100
 *   node scripts/agent.mjs test     run its tests
 *   node scripts/agent.mjs setup    create .venv and install requirements
 *
 * The Python path differs between Windows (.venv/Scripts) and the rest
 * (.venv/bin); this script hides that so `npm run agent` works everywhere.
 */

import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentDir = path.join(root, 'services', 'agent');
const venvPython = process.platform === 'win32'
  ? path.join(agentDir, '.venv', 'Scripts', 'python.exe')
  : path.join(agentDir, '.venv', 'bin', 'python');
const mode = process.argv[2] ?? 'start';

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: agentDir, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

if (mode === 'setup') {
  if (!fs.existsSync(venvPython)) run(process.platform === 'win32' ? 'python' : 'python3', ['-m', 'venv', '.venv']);
  run(venvPython, ['-m', 'pip', 'install', '-r', 'requirements.txt']);
  console.log('[agent] ready. Start it with: npm run agent');
  process.exit(0);
}

if (!fs.existsSync(venvPython)) {
  console.error('[agent] no virtual environment yet. Run: npm run agent:setup');
  process.exit(1);
}

const args = mode === 'test' ? ['-m', 'pytest', '-q', ...process.argv.slice(3)] : ['-m', 'cdo_agent'];
const child = spawn(venvPython, args, { cwd: agentDir, stdio: 'inherit' });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code) => process.exit(code ?? 0));
