/**
 * @file Viewer UI state — the bridge between the WebGL canvas and the DOM.
 *
 * ## The problem this solves
 *
 * `<Canvas>` mounts a *second* React reconciler whose host elements are
 * three.js objects rather than DOM nodes. A click lands on a `THREE.Mesh`
 * inside that tree, but the panel that must react to it is an ordinary `<aside>`
 * outside it. The two trees cannot talk through props — they have no common
 * parent below `<Provider>`.
 *
 * Redux resolves this cleanly, because **React Context propagates across the
 * R3F reconciler boundary**. `<Provider store>` wrapping the app is visible to
 * components rendered inside `<Canvas>`, so `useDispatch`/`useSelector` behave
 * identically on both sides. No portals, no event bus, no imperative refs.
 *
 * ## What belongs here, and what does not
 *
 * Only state that must CROSS the DOM/WebGL boundary:
 *   - `selectedMeshName` — set by a raycast inside the canvas, read by the
 *     inspector panel outside it (and back inside, to tint the mesh).
 *   - `discoveredMeshes` — produced by traversing the scene graph inside the
 *     canvas, consumed by the component picker outside it.
 *   - `cameraResetNonce` — set by a DOM button, consumed by the rig inside.
 *
 * Discovery lived on a callback prop in the first pass (`onMeshesDiscovered`
 * lifting into a parent `useState`). That coupled correctness to effect
 * ordering between a suspended child and its parent, and the parent's own
 * "reset on asset change" effect could clobber the result depending on which
 * ran last. State that crosses the boundary belongs in the store — the same
 * rule already applied to selection — so it lives here now and the hazard is
 * gone by construction.
 *
 * Ephemeral, single-tree state stays local. Hover in particular: pointer-move
 * fires continuously, and dispatching every frame would flood the store and
 * the devtools timeline with values nothing outside the canvas reads.
 *
 * @module features/twin-viewer/twinViewerSlice
 */

import { createSlice } from '@reduxjs/toolkit';

/**
 * @typedef {object} TwinViewerState
 * @property {string|null} selectedMeshName - Raw glTF name of the selected mesh.
 * @property {string|null} hoveredMeshName - Name under the cursor, throttled to
 *   changes only (see `TwinModel`), used for the HUD readout.
 * @property {import('../../lib/three-helpers.js').DiscoveredMesh[]} discoveredMeshes
 *   Every named mesh found in the loaded scene graph. Plain serialisable
 *   objects — never three.js instances, which must not enter the store.
 * @property {boolean} isModelLoaded - True once traversal has completed.
 * @property {boolean} isMappingPanelOpen - Whether the inspector sidebar is shown.
 * @property {number} cameraResetNonce - Incremented to command a camera refit.
 *   A counter rather than a boolean so repeated resets always register.
 * @property {boolean} showBlueprintGrid - Ground grid visibility.
 * @property {boolean} autoRotate - Slow turntable, for idle presentation.
 * @property {string} meshFilter - Search text for the mesh picker.
 */

/** @type {TwinViewerState} */
const initialState = {
  selectedMeshName: null,
  hoveredMeshName: null,
  discoveredMeshes: [],
  isModelLoaded: false,
  isMappingPanelOpen: true,
  cameraResetNonce: 0,
  showBlueprintGrid: true,
  autoRotate: false,
  meshFilter: '',
};

const twinViewerSlice = createSlice({
  name: 'twinViewer',
  initialState,
  reducers: {
    /**
     * Select a mesh by its raw glTF name.
     *
     * Dispatched from the R3F `onClick` raycast handler and from the DOM mesh
     * picker — both funnel through this one action, which is why clicking a
     * row in the list highlights the 3D part and vice versa, with no extra code.
     *
     * @param {TwinViewerState} state
     * @param {{payload: string}} action
     */
    selectMesh(state, action) {
      state.selectedMeshName = action.payload;
      state.isMappingPanelOpen = true;
    },

    /**
     * Clear the selection — clicking empty space in the viewport, or Escape.
     * @param {TwinViewerState} state
     */
    clearSelection(state) {
      state.selectedMeshName = null;
    },

    /**
     * Record the hovered mesh. `TwinModel` only dispatches this when the name
     * actually changes, never on every pointer-move frame.
     * @param {TwinViewerState} state
     * @param {{payload: string|null}} action
     */
    setHoveredMesh(state, action) {
      state.hoveredMeshName = action.payload;
    },

    /**
     * Publish the result of traversing the loaded scene graph.
     *
     * Dispatched from inside `<Canvas>` once the glTF has parsed. The payload
     * is plain data by contract — putting a `THREE.Object3D` in the store
     * would be non-serialisable and would retain GPU memory across navigation.
     *
     * @param {TwinViewerState} state
     * @param {{payload: import('../../lib/three-helpers.js').DiscoveredMesh[]}} action
     */
    setDiscoveredMeshes(state, action) {
      state.discoveredMeshes = action.payload;
      state.isModelLoaded = true;
    },

    /** @param {TwinViewerState} state */
    toggleMappingPanel(state) {
      state.isMappingPanelOpen = !state.isMappingPanelOpen;
    },

    /**
     * Ask the camera rig to re-frame the model. Consumed inside `<Canvas>`.
     * @param {TwinViewerState} state
     */
    requestCameraReset(state) {
      state.cameraResetNonce += 1;
    },

    /** @param {TwinViewerState} state */
    toggleBlueprintGrid(state) {
      state.showBlueprintGrid = !state.showBlueprintGrid;
    },

    /** @param {TwinViewerState} state */
    toggleAutoRotate(state) {
      state.autoRotate = !state.autoRotate;
    },

    /**
     * @param {TwinViewerState} state
     * @param {{payload: string}} action
     */
    setMeshFilter(state, action) {
      state.meshFilter = action.payload;
    },

    /**
     * Clear the discovered list. Dispatched by `TwinModel`'s unmount cleanup.
     *
     * Ownership matters here: the mesh list is written and cleared by exactly
     * one component, the one that holds the parsed scene. Nothing else touches
     * it — see the note on `resetViewer` for why.
     *
     * @param {TwinViewerState} state
     */
    clearDiscoveredMeshes(state) {
      state.discoveredMeshes = [];
      state.isModelLoaded = false;
    },

    /**
     * Reset per-asset interaction state when navigating between twins, so a
     * selection from the previous asset does not leak into the next.
     *
     * Deliberately does NOT clear `discoveredMeshes`. React runs child effects
     * before parent effects, so when drei serves a cached model the sequence on
     * navigation is: child publishes the mesh list → parent's reset effect
     * wipes it. Blanking the list here reintroduced exactly the race this slice
     * was meant to remove. `TwinModel` clears it on unmount instead, which is
     * ordered correctly by construction.
     *
     * @param {TwinViewerState} state
     */
    resetViewer(state) {
      state.selectedMeshName = null;
      state.hoveredMeshName = null;
      state.meshFilter = '';
      state.isMappingPanelOpen = true;
      state.autoRotate = false;
    },
  },
});

export const {
  selectMesh,
  clearSelection,
  setHoveredMesh,
  setDiscoveredMeshes,
  clearDiscoveredMeshes,
  toggleMappingPanel,
  requestCameraReset,
  toggleBlueprintGrid,
  toggleAutoRotate,
  setMeshFilter,
  resetViewer,
} = twinViewerSlice.actions;

/* ── Selectors ─────────────────────────────────────────────────────────────
   Exported as named functions so both the DOM tree and the R3F tree subscribe
   through the same reference, rather than each defining an inline lambda. */

/** @param {{twinViewer: TwinViewerState}} state */
export const selectSelectedMeshName = (state) => state.twinViewer.selectedMeshName;
/** @param {{twinViewer: TwinViewerState}} state */
export const selectHoveredMeshName = (state) => state.twinViewer.hoveredMeshName;
/** @param {{twinViewer: TwinViewerState}} state */
export const selectDiscoveredMeshes = (state) => state.twinViewer.discoveredMeshes;
/** @param {{twinViewer: TwinViewerState}} state */
export const selectIsModelLoaded = (state) => state.twinViewer.isModelLoaded;
/** @param {{twinViewer: TwinViewerState}} state */
export const selectIsMappingPanelOpen = (state) => state.twinViewer.isMappingPanelOpen;
/** @param {{twinViewer: TwinViewerState}} state */
export const selectCameraResetNonce = (state) => state.twinViewer.cameraResetNonce;
/** @param {{twinViewer: TwinViewerState}} state */
export const selectShowBlueprintGrid = (state) => state.twinViewer.showBlueprintGrid;
/** @param {{twinViewer: TwinViewerState}} state */
export const selectAutoRotate = (state) => state.twinViewer.autoRotate;
/** @param {{twinViewer: TwinViewerState}} state */
export const selectMeshFilter = (state) => state.twinViewer.meshFilter;

export default twinViewerSlice.reducer;
