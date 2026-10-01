/**
 * @file The icon set, imported one icon at a time.
 *
 * Phosphor's root barrel pulls in thousands of modules, which Vite's dev server
 * would have to transform on first load. Importing each glyph from its own file
 * keeps that to the handful actually used, and keeps the production bundle
 * honest. Add an icon here, then import it from this module; do not import
 * from `@phosphor-icons/react` directly anywhere else (an audit grep enforces
 * it).
 *
 * @module components/ui/icons
 */

export { ArrowClockwise } from '@phosphor-icons/react/dist/csr/ArrowClockwise';
export { ArrowCounterClockwise } from '@phosphor-icons/react/dist/csr/ArrowCounterClockwise';
export { ArrowLeft } from '@phosphor-icons/react/dist/csr/ArrowLeft';
export { ArrowRight } from '@phosphor-icons/react/dist/csr/ArrowRight';
export { ArrowsClockwise } from '@phosphor-icons/react/dist/csr/ArrowsClockwise';
export { ArrowSquareOut } from '@phosphor-icons/react/dist/csr/ArrowSquareOut';
export { CaretDown } from '@phosphor-icons/react/dist/csr/CaretDown';
export { Crosshair } from '@phosphor-icons/react/dist/csr/Crosshair';
export { CubeFocus } from '@phosphor-icons/react/dist/csr/CubeFocus';
export { GridFour } from '@phosphor-icons/react/dist/csr/GridFour';
export { Info } from '@phosphor-icons/react/dist/csr/Info';
export { MagnifyingGlass } from '@phosphor-icons/react/dist/csr/MagnifyingGlass';
export { MagnifyingGlassMinus } from '@phosphor-icons/react/dist/csr/MagnifyingGlassMinus';
export { MagnifyingGlassPlus } from '@phosphor-icons/react/dist/csr/MagnifyingGlassPlus';
export { Plus } from '@phosphor-icons/react/dist/csr/Plus';
export { Rows } from '@phosphor-icons/react/dist/csr/Rows';
export { UploadSimple } from '@phosphor-icons/react/dist/csr/UploadSimple';
export { Warning } from '@phosphor-icons/react/dist/csr/Warning';
export { WarningOctagon } from '@phosphor-icons/react/dist/csr/WarningOctagon';
export { X } from '@phosphor-icons/react/dist/csr/X';
