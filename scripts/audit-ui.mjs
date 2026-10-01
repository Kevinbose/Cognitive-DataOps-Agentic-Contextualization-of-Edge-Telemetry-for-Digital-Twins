#!/usr/bin/env node
/**
 * @file UI v3 forbidden-pattern audit.
 *
 * The design system is a set of rules (DESIGN.md), and rules that nothing
 * checks decay. This scans the client source for every pattern the system
 * bans and fails with `file:line` on the first sight of one:
 *
 *   - retired colour tokens and the soft, tinted fills they fed
 *   - shadows, gradients, blur, translucent panels
 *   - rounded corners (only `rounded-full` on circular markers is allowed)
 *   - transitions, transforms on press, and hover motion
 *   - text below 12 px
 *   - em and en dashes in anything a user can read
 *   - glyph characters standing in for icons
 *   - icon libraries other than Phosphor, and Phosphor imported any way but
 *     through `components/ui/icons.js`
 *   - the retired type classes
 *
 *   node scripts/audit-ui.mjs
 *
 * Exits non-zero on any violation, so it can run in CI or a pre-commit hook.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT = path.join(ROOT, 'client');

/**
 * @typedef {object} Rule
 * @property {string} id
 * @property {string} why
 * @property {RegExp} pattern
 * @property {(file: string) => boolean} [skip] - Files the rule does not apply to.
 * @property {boolean} [codeOnly] - Ignore comment lines.
 */

const isCss = (file) => file.endsWith('.css');
const isIconsModule = (file) => file.endsWith(path.join('components', 'ui', 'icons.js'));

/** @type {Rule[]} */
const RULES = [
  {
    id: 'retired-token',
    why: 'Token removed in v3 (soft tints, signal cyan, old aliases). Use primary, danger, warning, success, line, control.',
    pattern:
      /\b(?:bg|text|border|ring|fill|stroke|accent|outline|from|to|via|divide)-(?:signal|primary-soft|primary-border|success-soft|success-border|warning-soft|warning-border|danger-soft|danger-border|canvas-deep|overlay|line-strong)\b/,
  },
  {
    id: 'subtle-as-text',
    why: '`ink-subtle` is for non-text marks only; it does not reach 4.5:1. Use `ink-muted`.',
    pattern: /\btext-ink-subtle\b|placeholder:text-ink-subtle/,
  },
  {
    id: 'shadow',
    why: 'No shadows. Elevation is a tone step and a ruled edge.',
    pattern: /\bshadow(?:-[a-z0-9\[\]_]+)?\b|box-shadow/,
    skip: (file) => isCss(file),
  },
  {
    id: 'gradient',
    why: 'No gradients.',
    pattern: /\b(?:bg-gradient|from-|via-|to-(?:primary|signal|ink))|linear-gradient|radial-gradient|conic-gradient/,
    skip: (file) => isCss(file),
  },
  {
    id: 'blur',
    why: 'No blur or frosted glass.',
    pattern: /\bbackdrop-blur|\bblur-|backdrop-filter|filter:\s*blur/,
    skip: (file) => isCss(file),
  },
  {
    id: 'translucent-surface',
    why: 'Panels are opaque.',
    pattern: /\bbg-(?:surface|canvas|raised|sunken|stage)\/\d+/,
  },
  {
    id: 'rounded',
    why: 'Square corners. `rounded-full` is allowed only for circular state markers and spinners.',
    pattern: /\brounded(?:-(?:none|xs|sm|md|lg|xl|2xl|3xl|4xl|t|b|l|r|tl|tr|bl|br)(?:-[a-z0-9]+)?)?\b(?!-full)/,
    skip: (file) => isCss(file),
  },
  {
    id: 'transition',
    why: 'Hover and focus change colour instantly. Functional motion only (width of the load bar, skeleton pulse, spinner).',
    pattern: /\btransition(?:-[a-z\[\],-]+)?\b|\bduration-\d+\b|\bease-(?:in|out|linear)/,
    skip: (file) => isCss(file) || file.endsWith('TwinCanvas.jsx'),
  },
  {
    id: 'press-transform',
    why: 'No press or hover transforms.',
    pattern: /\bactive:scale|\bhover:(?:scale|-?translate)|\bhover:rotate/,
  },
  {
    id: 'small-text',
    why: 'Nothing under 12 px.',
    pattern: /text-\[(?:[0-9]|1[01])(?:\.\d+)?px\]/,
  },
  {
    id: 'legacy-class',
    why: 'Retired type or surface classes.',
    pattern: /\blabel-micro\b|\bmetric-figure\b|\bblueprint-grid\b|\bcard\b(?=[\s"'`])(?<=className=["'`{][^"'`]*)/,
  },
  {
    id: 'dash-in-text',
    why: 'No em or en dashes in anything a user can read. Use a comma, colon, period or hyphen.',
    pattern: /[—–]/,
    codeOnly: true,
  },
  {
    id: 'glyph-icon',
    why: 'Icons come from Phosphor, never from a glyph character.',
    pattern: /[←-⇿■-◿☀-➿⌀-⏿×]/,
    codeOnly: true,
  },
  {
    id: 'emoji',
    why: 'No emoji.',
    pattern: /[\u{1F300}-\u{1FAFF}\u{2B50}\u{2705}\u{274C}]/u,
  },
  {
    id: 'other-icon-library',
    why: 'Phosphor only.',
    pattern: /from\s+['"](?:lucide-react|feather-icons|react-feather|@heroicons|react-icons|@radix-ui\/react-icons)/,
  },
  {
    id: 'phosphor-direct-import',
    why: 'Import Phosphor icons only through components/ui/icons.js (per-icon paths keep Vite fast).',
    pattern: /from\s+['"]@phosphor-icons\/react(?:['"]|\/dist\/(?!csr\/))/,
    skip: isIconsModule,
  },
  {
    id: 'external-font',
    why: 'Fonts are self-hosted.',
    pattern: /fonts\.googleapis|fonts\.gstatic|use\.typekit|cdnjs\.cloudflare\.com\/ajax\/libs\/font/,
  },
  {
    id: 'banned-typeface',
    why: 'Inter, Geist and Space Grotesk are banned.',
    pattern: /['"]?(?:Inter|Geist|Space Grotesk)['"]?\s*[,;)]|font-(?:inter|geist)/,
  },
  {
    id: 'pure-white',
    why: 'No pure white or pure black. The lightest surface is `raised` (#f9faf8).',
    pattern: /#fff(?:fff)?\b|#000(?:000)?\b|\bbg-white\b|\btext-white\b|\bbg-black\b/i,
    skip: (file) => file.endsWith('SceneLighting.jsx') || file.endsWith('TwinCanvas.jsx'),
  },
  {
    id: 'middle-dot-separator',
    why: 'The middle dot is rationed. Use a comma or separate elements.',
    pattern: /\s·\s/,
    codeOnly: true,
  },
];

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(jsx?|css|html)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Whether a line is only a comment (so a dash in it is not user-visible).
 * @param {string} line
 * @returns {boolean}
 */
function isCommentLine(line) {
  const t = line.trim();
  return (
    t.startsWith('//') ||
    t.startsWith('*') ||
    t.startsWith('/*') ||
    t.startsWith('{/*') ||
    t.startsWith('<!--') ||
    t.startsWith('-->')
  );
}

const files = [...walk(path.join(CLIENT, 'src')), path.join(CLIENT, 'index.html')];
let violations = 0;
let inBlockComment = false;

for (const file of files) {
  const rel = path.relative(ROOT, file);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  inBlockComment = false;

  lines.forEach((line, index) => {
    // Track multi-line block and JSX comments so their contents are skipped.
    const startsBlock = /\/\*/.test(line) && !/\*\//.test(line);
    const inComment = inBlockComment || isCommentLine(line);
    if (startsBlock) inBlockComment = true;
    if (inBlockComment && /\*\//.test(line)) inBlockComment = false;

    for (const rule of RULES) {
      if (rule.skip?.(file)) continue;
      if (rule.codeOnly && inComment) continue;
      // Class-name rules are about markup, not prose in a comment.
      if (inComment && !rule.codeOnly && rule.id !== 'emoji') continue;
      if (rule.pattern.test(line)) {
        violations += 1;
        console.log(`${rel}:${index + 1}  [${rule.id}]  ${line.trim().slice(0, 110)}`);
        console.log(`    ${rule.why}`);
      }
    }
  });
}

console.log(
  violations === 0
    ? `\nUI audit clean: ${files.length} files, ${RULES.length} rules.`
    : `\nUI audit FAILED: ${violations} violation${violations === 1 ? '' : 's'} in ${files.length} files.`,
);
process.exit(violations === 0 ? 0 : 1);
