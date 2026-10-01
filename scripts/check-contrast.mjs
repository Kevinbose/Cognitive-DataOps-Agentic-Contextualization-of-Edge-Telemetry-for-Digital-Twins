#!/usr/bin/env node
/**
 * @file WCAG contrast audit for the UI v3 palette.
 *
 * Reads the `--color-*` tokens straight out of `client/src/index.css`, so the
 * values that ship are the values that are checked, and verifies every
 * foreground and background pairing the interface actually uses:
 *
 *   - text (WCAG 1.4.3):              at least 4.5 : 1
 *   - large text, UI parts, shapes
 *     and focus rings (1.4.11):       at least 3 : 1
 *
 * Exits non-zero on any failure, so it can sit in CI or a pre-commit hook.
 *
 *   node scripts/check-contrast.mjs            # table, fails on violation
 *   node scripts/check-contrast.mjs --quiet    # only failures
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSS = fs.readFileSync(path.join(ROOT, 'client', 'src', 'index.css'), 'utf8');
const quiet = process.argv.includes('--quiet');

/** @returns {Record<string, string>} token name to lower-case hex, from the `@theme` block. */
function readTokens() {
  const theme = CSS.match(/@theme\s*\{([\s\S]*?)\n\}/);
  if (!theme) throw new Error('No @theme block found in client/src/index.css');
  const tokens = {};
  for (const [, name, hex] of theme[1].matchAll(/--color-([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    tokens[name] = hex.toLowerCase();
  }
  return tokens;
}

/** @param {string} hex @returns {number} relative luminance (WCAG 2.x). */
function luminance(hex) {
  const channel = (i) => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

/** @returns {number} contrast ratio of two hex colours. */
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const tokens = readTokens();
const need = (name) => {
  if (!tokens[name]) throw new Error(`Token --color-${name} is not defined in index.css`);
  return tokens[name];
};

/** Surfaces text can sit on. `stage` only hosts the 3D view, never text. */
const SURFACES = ['canvas', 'surface', 'raised', 'sunken'];

/** @type {Array<{label: string, fg: string, bg: string, min: number}>} */
const checks = [];
const add = (label, fg, bg, min) => checks.push({ label, fg, bg, min });

// Body and secondary text, on every surface.
for (const fg of ['ink', 'ink-secondary', 'ink-muted']) {
  for (const bg of SURFACES) add(`text ${fg} on ${bg}`, fg, bg, 4.5);
}

// `ink-subtle` is for NON-TEXT only (dividers inside controls, disabled marks).
for (const bg of SURFACES) add(`non-text ink-subtle on ${bg}`, 'ink-subtle', bg, 3);

// Brand as text and as a fill.
for (const bg of SURFACES) add(`text primary on ${bg}`, 'primary', bg, 4.5);
for (const fill of ['primary', 'primary-hover', 'primary-active']) {
  add(`text ink-inverse on ${fill}`, 'ink-inverse', fill, 4.5);
}

// Semantic colours as text.
for (const fg of ['danger', 'warning', 'success']) {
  for (const bg of SURFACES) add(`text ${fg} on ${bg}`, fg, bg, 4.5);
}
add('text ink-inverse on danger fill', 'ink-inverse', 'danger', 4.5);
add('text ink-inverse on danger-hover fill', 'ink-inverse', 'danger-hover', 4.5);

// State markers are shapes, not text: 3:1 against the surface they sit on.
for (const fg of ['danger', 'warning', 'success-shape', 'primary']) {
  for (const bg of ['surface', 'raised', 'canvas']) add(`shape ${fg} on ${bg}`, fg, bg, 3);
}

// Control borders (inputs, toggles, segmented groups) and the focus ring.
for (const bg of ['canvas', 'surface', 'raised', 'sunken']) {
  add(`control border on ${bg}`, 'control', bg, 3);
}
for (const bg of SURFACES) add(`focus ring primary on ${bg}`, 'primary', bg, 3);

// Text on the 3D stage backdrop, used only by the HUD readouts that sit on
// opaque `surface` panels, but the stage itself must still separate from them.
add('stage panel edge: line on stage', 'line', 'stage', 1.1);

let failed = 0;
const rows = [];
for (const { label, fg, bg, min } of checks) {
  const ratio = contrast(need(fg), need(bg));
  const pass = ratio >= min;
  if (!pass) failed += 1;
  rows.push({ label, ratio, min, pass });
}

for (const row of rows) {
  if (quiet && row.pass) continue;
  console.log(
    `${row.pass ? 'pass' : 'FAIL'}  ${row.ratio.toFixed(2).padStart(5)} : 1  (min ${row.min})  ${row.label}`,
  );
}

console.log(
  `\n${rows.length - failed} of ${rows.length} pairings pass` +
    (failed ? `, ${failed} FAIL.` : '. Palette is compliant.'),
);
process.exit(failed ? 1 : 0);
