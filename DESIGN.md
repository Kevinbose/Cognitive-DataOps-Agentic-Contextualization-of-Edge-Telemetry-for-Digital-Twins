# Design System: Cognitive DataOps console (UI v3)

The single source of truth for how the console looks and why. The values here are
the values in [`client/src/index.css`](client/src/index.css); two scripts keep the
two honest:

```bash
node scripts/check-contrast.mjs   # every foreground/background pairing, WCAG 2.x
node scripts/audit-ui.mjs         # every banned pattern, file:line, exits non-zero
```

This file replaces an earlier copy of another product's design notes that had been
committed by mistake and steered any agent reading it toward the wrong theme.

## 1. Visual theme and atmosphere

**Quiet chrome, loud content.** The console frames a colourful 3D model of a plant,
so the frame is deliberately mineral: warm-neutral greys, one petrol brand hue, and
three state colours that mean state and nothing else (the ISA-101 high-performance
HMI idea: colour is for what needs attention).

Structure comes from ruled lines, a 2 px ink top rule on the stat strip, and an
inverted (light on dark) fill for the selected item. It never comes from shadow,
blur, gradient, glass or rounded corners.

| Dial | Setting | Meaning here |
|---|---|---|
| Density | 7, "daily instrument" | Tables and readouts are compact; panels breathe at the edges |
| Variance | 3, "predictable" | A console rewards consistency. No asymmetric hero, no showpiece layout |
| Motion | 1, "static" | Only functional motion: skeleton pulse, spinner, load bar, 3D flash and pulse |

This is a light interface by decision, not by default. There is no dark theme, and
no section of any page inverts.

## 2. Colour palette and roles

All values are sRGB hex. **No pure white and no pure black anywhere**: the lightest
surface is `raised` (#F9FAF8) and the darkest ink is #151D1C.

### Surfaces

| Token | Hex | Role |
|---|---|---|
| `canvas` | #E7E8E4 | The page |
| `surface` | #F3F4F1 | Panels, header, footer |
| `raised` | #F9FAF8 | Inputs, menus, the lightest thing on screen |
| `sunken` | #DCDED9 | Table headers, wells, skeleton bars |
| `stage` | #D4D7D1 | Backdrop of the 3D viewport (the sample models are pale) |

Tone steps alone are faint (surface against canvas is only 1.12:1), so every panel
also carries a 1 px `line` edge. Do not rely on tone to separate things.

### Structure and text

| Token | Hex | Role | Contrast |
|---|---|---|---|
| `line` | #BABEB6 | Decorative hairlines: panel edges, table rules | n/a |
| `control` | #777D74 | Border of anything you operate: inputs, toggles, checkbox | 3.12 to 4.04 on every surface |
| `ink` | #151D1C | Primary text | 12.65 to 16.38 |
| `ink-secondary` | #35413F | Labels, secondary text | 7.83 to 10.13 |
| `ink-muted` | #56625F | Captions, hints, placeholders | 4.68 to 6.06 |
| `ink-subtle` | #737E79 | **Non-text only**: disabled marks, inner dividers | 3.11 to 4.02 |
| `ink-inverse` | #F9FAF8 | Text on brand, alarm and ink fills | 7.11 on brand |

`ink-subtle` never carries text. Placeholder text is `ink-muted`.

### Brand: petrol

| Token | Hex | Role |
|---|---|---|
| `primary` | #135E66 | Actions, selection, focus ring, links. Nothing else carries this hue |
| `primary-hover` | #0E4950 | Hover |
| `primary-active` | #0A363B | Pressed |

One accent, locked for the whole product. Saturation is about 68 percent.

### State

| Token | Hex | Shape | Meaning |
|---|---|---|---|
| `success` (text) / `success-shape` | #1B6A39 / #208D3F | dot | normal, online, active |
| `warning` | #8C5300 | triangle | warn, stale |
| `danger` | #B3261E | square | alarm, error, destructive |
| `ink-muted` | #56625F | ring | offline, unknown, retired |
| `flash` | #24A148 | (3D only) | the bind flash, an emissive colour, never a UI colour |

**State is carried by shape and text as well as hue.** Alarm and warn are hard to
tell apart under deuteranopia, so each state has its own shape (dot, triangle,
square, ring) and its own word. See `components/ui/StatusMarker.jsx`.

### 3D scene tints

Highlights on the model are emissive light colours, not UI tokens, and they are
the only place the interface is allowed to be loud. One mechanism, the compositor
in `client/src/features/twin-viewer/scene/highlightCompositor.js`, paints the
single winning tone on each mesh. Higher priority wins, and a mesh keeps its own
cloned materials so the original look is restored exactly when the tone ends.

| Tone | Emissive | Strength | Priority | Pulses | Used for |
|---|---|---|---|---|---|
| `agent` | #B3261E | 1.00 | 5 | yes | The component the diagnosis agent names (Phase 5) |
| `alarm` | #B3261E | 0.90 | 4 | yes | A bound channel in alarm |
| `warn` | #D98400 | 0.85 | 3 | no | A bound channel in warning |
| `flash` | #24A148 | 1.00 | 2 | no | Bind confirmation, for 1.6 s |
| `select` | #135E66 | 1.00 | 1 | no | The selected mesh |
| `hover` | #2F8A94 | 0.45 | 0 | no | The hovered mesh |

The amber for `warn` is brighter than the `warning` text colour (#8C5300) on
purpose: an emissive tint on a pale model has to read as a light, where the text
colour is chosen to read on a pale surface. The 3D tints are exempt from the
contrast table because they sit on shaded geometry, not on a UI surface, so a
tint never carries state alone: the same state shows as a marker and a word in the
channel list, and the pulse is steady under `prefers-reduced-motion`.

### Verified pairings

58 pairings are checked by `scripts/check-contrast.mjs`: text at least 4.5:1,
shapes, control borders and the focus ring at least 3:1. Tightest passing values:
`ink-muted` on `sunken` 4.68, `warning` on `sunken` 4.62, `success` on `sunken` 4.89.

## 3. Typography

| Role | Face | Spec |
|---|---|---|
| Page title | Archivo, variable width, `font-stretch: 112.5%` | 600, 28/32 |
| Static figure | Archivo, semi-expanded | 600, 40/44 |
| Section heading | IBM Plex Sans | 600, 16/24 |
| Body | IBM Plex Sans | 400, 14/20 |
| Table | IBM Plex Sans | 13/18 |
| Label, caption, hint | IBM Plex Sans | 500, 12/16 |
| Data and identifiers | IBM Plex Mono | 400 and 500, 13/18, tabular figures |
| Legal body | IBM Plex Sans | 16/26 at about 65 characters |

- **Nothing is set below 12 px.**
- **Every number that changes is Plex Mono.** Archivo's tabular figures are glyph
  variants whose widths differ by weight, so a ticking value in it would jitter.
  Archivo is for page titles and counts that do not tick.
- Sentence case everywhere: "Asset registry", not "Asset Registry". (The Vercel
  guidelines ask for Title Case in headings; that rule is waived here and recorded
  in section 8.)
- No em dashes, no en dashes as separators, no `it is not X, it is Y` phrasing, no
  middle-dot separators. Use a comma, colon, period or hyphen.
- All three families are self-hosted through `@fontsource`. No request leaves the
  origin, so the console works offline at a demo and the privacy page is truthful.
  Licences: Plex and Archivo are SIL OFL 1.1.
- `font-synthesis: none`: the browser must not fake a bold or italic Plex was not
  drawn with.

## 4. Component stylings

- **Corners:** 0 px on everything. `rounded-full` is allowed only on the small
  circular spinner and never on a control.
- **Elevation:** none. No shadow, no blur, no translucency. Panels are opaque.
- **Buttons:** a real `<button>` or router `<Link>`. Primary is a petrol fill with
  light text. Secondary is a `raised` fill with a `control` border. Danger is alarm.
  Hover and press change colour **instantly**: no transition, no transform. A
  filled button is used for the single primary action on a view; everything else
  is secondary or a text link.
- **Inputs:** label above, hint or error below, never placeholder-as-label. `raised`
  fill, 1 px `control` border, focus is the global 2 px brand outline plus a brand
  border. Errors add an icon and text, never colour alone, and are wired through
  `aria-invalid` and `aria-describedby`.
- **Segmented controls:** one bordered group with 1 px dividers. The active segment
  is an inverted ink fill. Every segment is a real `button` with `aria-pressed`.
- **Status:** an asset's status is a three-segment ratchet glyph (filled from the
  left as far as it has got) plus its name. A live channel uses the shape set above.
- **Panels:** a 1 px `line` edge, a ruled header, no icon tile, and no
  `overflow-hidden` (it would clip focus rings). A danger panel draws its whole
  border in alarm, with no fill.
- **Tables:** `sunken` header row, hairline row rules, hover is an instant `sunken`
  fill, numbers right-aligned in Plex Mono, row actions as small buttons. A table
  wider than its container scrolls inside a focusable, labelled region.
- **Loading:** a skeleton of the real layout: static `sunken` bars that only change
  opacity. No shimmer gradient, no centred spinner, announced once in a live region.
- **Empty:** a ruled row that says what is missing and how to fix it, with a text
  action. First run shows the three-stage ratchet. No illustration tile.
- **Error:** a fully bordered notice with an icon and a next step. No tinted fill,
  no coloured side stripe.
- **Icons:** Phosphor, regular weight, `currentColor`, 16 px inline and 20 px in
  toolbars, no container tile, at most one per row. Imported one icon at a time
  through `components/ui/icons.js`. Decorative icons are `aria-hidden`; an
  icon-only button carries an `aria-label`.

## 5. Layout principles

- CSS Grid for structure. A 4 px base: 4, 8, 12, 16, 24, 32, 48, 64.
- The console content is contained to 1600 px. The viewer is full-bleed on
  `h-dvh` (never `h-screen`) and is three columns: components 288 px, viewport,
  inspector 360 px, separated by hairlines.
- The stat strip is one ruled band (2 px ink top rule, 1 px bottom rule, 1 px
  vertical dividers), not a row of cards. Above its figures, one proportional bar
  draws the status ratchet.
- No bento grid, no three-equal-cards row, no pricing tiers, no testimonials, no
  hero. This is an instrument, not a landing page.
- Below `lg` the multi-column viewer collapses to a single column. No horizontal
  page scroll at any width.
- Every routed page has exactly one `<h1>` (via `PageHeader`), a per-route
  `document.title`, a skip link, and a `<main>`.

## 6. Motion

Hover and focus change colour instantly. There is no hover animation, no animated
arrow, no scroll reveal, no stagger. The only motion is functional:

- a skeleton's opacity pulse,
- a button spinner and the model load bar,
- the 3D bind flash (1.6 s) and the pulse on an agent or alarm highlight.

Under `prefers-reduced-motion` all of it is stilled: pulses become a steady
highlight of the same duration.

## 7. Anti-patterns (banned, and enforced by `scripts/audit-ui.mjs`)

The product owner's list, as rules:

1. No harsh or decorative gradients, and no radial orbs.
2. No Lucide, Feather or Heroicons. Phosphor only. No sparkle icons.
3. No pure white or pure black backgrounds.
4. No rainbow colouring: one brand hue plus three state colours.
5. No drop shadows. No liquid glass, blur or frosted panels.
6. No row of three equal feature cards. No bento grids.
7. No emoji. No em dashes.
8. No Inter, Geist or Space Grotesk.
9. No coloured left stripe on a card or alert.
10. No fake testimonials or invented customers. No three-tier pricing.
11. No terminal-window or faux-OS chrome. No checkmark bullet lists.
12. No "it is not X, it is Y" copy.
13. No soft pill corner radius. No purple-and-black palette. No neon. No basic pastels.
14. No dot grid or blueprint pattern behind the chrome. (The 3D ground grid stays: it
    is a measuring aid, drawn in neutral lines.)
15. No animated arrows. No hover animation.
16. No mock product screenshots: every visual is the real interface.

Two items phrased as absences are read as things to include: skeleton loaders, and
terms and privacy pages with a footer.

## 8. Recorded waivers

| Rule | Decision | Reason |
|---|---|---|
| Vercel: Title Case headings | Waived, sentence case | Product owner's taste list |
| Vercel: confirm or undo destructive actions | Unbind is immediate | Bindings are retired, not deleted; the history row allows re-binding |
| Vercel: a11y at 44 px targets | Buttons are 36 to 40 px tall | Dense operator console; every control is keyboard operable and labelled |
| Skill guidance: perpetual micro-motion | Declined | Product owner bans hover animation; a console should not animate at rest |

## 9. Skills that informed this system, and how

`redesign-existing-projects` for the scan, diagnose, fix process and the parity
rule. `design-taste-frontend` for the locks (one accent, one shape system, one
theme) and the contrast checks. `minimalist-ui` for the flat, bordered, typographic
hierarchy (its pastel badges were rejected). `industrial-brutalist-ui` for
structure only: ruled compartments, mono data, tabular numerals; its palette and
uppercase labels were not used. `high-end-visual-design` for type scale and spacing
only. `stitch-design-taste` for this document's format.

## 10. Verification

```bash
node scripts/check-contrast.mjs            # 58 of 58 pairings pass
node scripts/audit-ui.mjs                  # 20 rules, 0 violations
npm run build --workspace client           # production build compiles
```

Functional parity with the previous interface was checked route by route (links,
controls, states, headings) against a baseline captured before the refactor; the
deliberate additions were an `<h1>` on every page, per-route titles, labelled
scroll regions, a skip link and `<main>` on the viewer, zoom and rotate buttons,
skeleton loaders, and the terms and privacy pages.
