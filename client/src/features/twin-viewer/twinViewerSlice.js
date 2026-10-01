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
 * @property {{action: 'zoomIn'|'zoomOut'|'rotateLeft'|'rotateRight'|'focus'|null, meshName: string|null, nonce: number}} cameraCommand
 *   A one-shot instruction from a toolbar button, or (later) the diagnosis agent.
 *   Same counter trick as the reset: pressing "zoom in" twice must act twice,
 *   which a plain string would not. `focus` frames one mesh and carries its name.
 * @property {Record<string, Highlight[]>} highlights - Transient highlights per mesh name.
 *   The compositor (`scene/highlightCompositor.js`) layers these with selection,
 *   hover and live alarm state. Plain data: never a three.js object.
 * @property {boolean} showBlueprintGrid - Ground grid visibility.
 * @property {boolean} autoRotate - Slow turntable, for idle presentation.
 * @property {string} meshFilter - Search text for the mesh picker.
 */

/**
 * One transient highlight on a mesh.
 *
 * @typedef {object} Highlight
 * @property {string} id - Unique, so a newer highlight is never removed by an older timer.
 * @property {'flash'|'agent'} source - Who asked for it. Drives priority.
 * @property {boolean} pulse - Whether it pulses (steady under reduced motion).
 */

/** @type {TwinViewerState} */
const initialState = {
  selectedMeshName: null,
  hoveredMeshName: null,
  discoveredMeshes: [],
  isModelLoaded: false,
  isMappingPanelOpen: true,
  cameraResetNonce: 0,
  cameraCommand: { action: null, meshName: null, nonce: 0 },
  highlights: {},
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

    /**
     * Nudge the camera from a toolbar button. Consumed inside `<Canvas>` by
     * `CameraCommands`. This gives every orbit gesture a click and keyboard
     * alternative, which a drag-only control does not have.
     *
     * @param {TwinViewerState} state
     * @param {{payload: 'zoomIn'|'zoomOut'|'rotateLeft'|'rotateRight'|{action: 'focus', meshName: string}}} action
     */
    requestCameraCommand(state, action) {
      const command =
        typeof action.payload === 'string'
          ? { action: action.payload, meshName: null }
          : { action: action.payload.action, meshName: action.payload.meshName };
      state.cameraCommand = { ...command, nonce: state.cameraCommand.nonce + 1 };
    },

    /**
     * Add a highlight to a mesh. Prefer the `flashMesh` thunk, which also
     * schedules its removal.
     *
     * @param {TwinViewerState} state
     * @param {{payload: {meshName: string, highlight: Highlight}}} action
     */
    highlightAdded(state, action) {
      const { meshName, highlight } = action.payload;
      (state.highlights[meshName] ??= []).push(highlight);
    },

    /**
     * Remove ONE highlight by id. Matching on the id (not the mesh) is what stops
     * an old timer from clearing a highlight that replaced it.
     *
     * @param {TwinViewerState} state
     * @param {{payload: {meshName: string, id: string}}} action
     */
    highlightRemoved(state, action) {
      const { meshName, id } = action.payload;
      const remaining = (state.highlights[meshName] ?? []).filter((item) => item.id !== id);
      if (remaining.length > 0) state.highlights[meshName] = remaining;
      else delete state.highlights[meshName];
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
      state.highlights = {};
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
  requestCameraCommand,
  highlightAdded,
  highlightRemoved,
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
export const selectCameraCommand = (state) => state.twinViewer.cameraCommand;
/** @param {{twinViewer: TwinViewerState}} state */
export const selectHighlights = (state) => state.twinViewer.highlights;
/** @param {{twinViewer: TwinViewerState}} state */
export const selectShowBlueprintGrid = (state) => state.twinViewer.showBlueprintGrid;
/** @param {{twinViewer: TwinViewerState}} state */
export const selectAutoRotate = (state) => state.twinViewer.autoRotate;
/** @param {{twinViewer: TwinViewerState}} state */
export const selectMeshFilter = (state) => state.twinViewer.meshFilter;

/** How long the bind confirmation flash lasts. */
export const FLASH_DURATION_MS = 1600;

let nextHighlightId = 1;

/**
 * Flash a mesh green to confirm a bind.
 *
 * Adds a highlight and schedules exactly that highlight's removal. The timer
 * removes by id, so binding the same mesh again inside the window cannot be
 * cut short by the first flash's timer.
 *
 * @param {string} meshName - Raw glTF mesh name.
 * @param {number} [durationMs]
 * @returns {(dispatch: Function) => string} A thunk; resolves to the highlight id.
 */
export const flashMesh =
  (meshName, durationMs = FLASH_DURATION_MS) =>
  (dispatch) => {
    const id = `flash-${nextHighlightId}`;
    nextHighlightId += 1;

    dispatch(highlightAdded({ meshName, highlight: { id, source: 'flash', pulse: false } }));
    setTimeout(() => dispatch(highlightRemoved({ meshName, id })), durationMs);
    return id;
  };

export default twinViewerSlice.reducer;
