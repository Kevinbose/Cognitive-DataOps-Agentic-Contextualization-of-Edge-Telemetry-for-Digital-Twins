#!/usr/bin/env node
/**
 * @file Claude Code PreToolUse hook: keep the assistant away from credential files.
 *
 * The protected files are the board's `firmware/**\/secrets.h` (Wi-Fi password,
 * broker credentials) and the server's `.env` files (database and broker
 * credentials). Creating and holding them is the user's job.
 *
 * A `Read` deny rule in `.claude/settings.json` covers the Read tool, but it
 * cannot see a shell `cat`, `type`, `Get-Content`, `grep` or `node -e`. This hook
 * covers those: for a shell tool it refuses any command that NAMES a protected
 * file, whatever the verb. For the file tools it checks the path.
 *
 * The templates (`secrets.example.h`, `.env.example`) are public and allowed.
 * Running the server does not name `.env` on the command line, so it is not
 * affected, and `fw doctor` reports which settings still hold a placeholder
 * without printing any value.
 *
 * Contract (Claude Code hooks): the tool call arrives as JSON on stdin. Exit
 * code 2 blocks it and sends stderr back to the assistant; any other exit lets it
 * proceed. A hook that crashes must not brick every tool, so internal errors
 * exit 0 and the `permissions.deny` rules remain the first line of defence.
 *
 * @module scripts/hooks/guard-secrets
 */

import { pathToFileURL } from 'node:url';

/** Tools whose whole `command` is scanned. */
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

/** Tools where only the path arguments are scanned (their content may discuss secrets). */
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'NotebookEdit', 'Grep', 'Glob']);

/** Fields of a file tool's input that hold a path or pattern. */
const PATH_FIELDS = ['file_path', 'notebook_path', 'path', 'pattern', 'glob'];

/** `secrets.h`, but not `secrets.example.h`. */
const SECRETS_HEADER = /(?<![A-Za-z0-9_-])secrets\.h(?![A-Za-z0-9_])/;

/**
 * `.env` and `.env.<anything>` except `.env.example`. The lookbehind keeps
 * `process.env.NODE_ENV` and `dotenv` from matching.
 */
const ENV_FILE = /(?<![A-Za-z0-9_])\.env(?:\.([A-Za-z0-9_-]+))?(?![A-Za-z0-9_])/g;

/** Git commands that name a path without printing the file. */
const HARMLESS_GIT = /^\s*git\s+(?:check-ignore|ls-files|status)\b/;

/**
 * @param {string} text
 * @returns {string|null} Which protected file the text names, or null.
 */
export function protectedFileIn(text) {
  if (SECRETS_HEADER.test(text)) return 'firmware secrets.h';
  for (const match of text.matchAll(ENV_FILE)) {
    if (match[1] !== 'example') return 'an .env file';
  }
  return null;
}

/**
 * @param {{tool_name?: string, tool_input?: Record<string, unknown>}} payload
 * @returns {{blocked: boolean, reason?: string}}
 */
export function evaluate(payload) {
  const tool = payload?.tool_name ?? '';
  const input = payload?.tool_input ?? {};

  /** @type {string[]} */
  let scanned = [];

  if (SHELL_TOOLS.has(tool)) {
    const command = typeof input.command === 'string' ? input.command : '';
    if (HARMLESS_GIT.test(command)) return { blocked: false };
    scanned = [command];
  } else if (FILE_TOOLS.has(tool)) {
    scanned = PATH_FIELDS.map((field) => input[field]).filter((v) => typeof v === 'string');
  } else {
    return { blocked: false };
  }

  for (const text of scanned) {
    const hit = protectedFileIn(text);
    if (hit) {
      return {
        blocked: true,
        reason:
          `Blocked: this ${tool} call names ${hit}, which holds credentials that belong to the user. ` +
          'Do not read, print, copy or edit it. Work from secrets.example.h or server/.env.example instead, ' +
          'run `node scripts/fw.mjs doctor` to see which settings still hold a placeholder, ' +
          'or ask the user to make the change themselves.',
      };
    }
  }
  return { blocked: false };
}

/** @returns {Promise<string>} */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    return; // Not a payload we understand: do not get in the way.
  }

  const verdict = evaluate(payload);
  if (verdict.blocked) {
    process.stderr.write(`${verdict.reason}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch(() => {
    /* fail open: see the file header */
  });
}
