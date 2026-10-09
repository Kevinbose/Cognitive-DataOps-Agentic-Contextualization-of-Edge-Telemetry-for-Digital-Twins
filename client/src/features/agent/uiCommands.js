/**
 * @file The agent pointing at the twin: highlight, camera focus, selection,
 * clearing, and opening a report.
 *
 * Commands arrive on the socket (`ui:command`, sent to this tab only) after the
 * API has checked every mesh name against the twin's model. They are applied
 * only while that twin is the one on screen. Highlights use the `agent` tone of
 * the highlight compositor (the strongest tone) and expire on their own, so a
 * forgotten highlight never stays lit.
 *
 * @module features/agent/uiCommands
 */

import {
  highlightAdded,
  highlightRemoved,
  requestCameraCommand,
  selectMesh,
} from '../twin-viewer/twinViewerSlice.js';
import { pointerCleared, pointerSet, reportOpened } from './agentSlice.js';

const DEFAULT_HIGHLIGHT_MS = 20_000;

/** Live agent highlights: id to mesh and timer, so "clear" can find them all. */
const live = new Map();
let nextId = 1;

/**
 * @param {string} meshName
 * @param {{pulse?: boolean, durationMs?: number}} options
 */
const addAgentHighlight = (meshName, { pulse = true, durationMs = DEFAULT_HIGHLIGHT_MS } = {}) => (dispatch) => {
  const id = `agent-${nextId}`;
  nextId += 1;
  dispatch(highlightAdded({ meshName, highlight: { id, source: 'agent', pulse } }));
  const timer = setTimeout(() => {
    live.delete(id);
    dispatch(highlightRemoved({ meshName, id }));
  }, durationMs);
  live.set(id, { meshName, timer });
};

/** Remove every highlight the agent placed. */
export const clearAgentHighlights = () => (dispatch) => {
  for (const [id, { meshName, timer }] of live) {
    clearTimeout(timer);
    dispatch(highlightRemoved({ meshName, id }));
  }
  live.clear();
  dispatch(pointerCleared());
};

/**
 * Apply a batch of commands for one twin.
 *
 * @param {{assetId: string, commands: Array<Record<string, any>>}} payload
 */
export const applyUiCommands =
  ({ assetId, commands }) =>
  (dispatch, getState) => {
    if (!assetId || getState().agent.activeAssetId !== assetId) return;
    for (const cmd of commands ?? []) {
      switch (cmd.type) {
        case 'highlight':
          dispatch(addAgentHighlight(cmd.meshName, { pulse: cmd.pulse ?? true, durationMs: cmd.durationMs }));
          if (cmd.label) dispatch(pointerSet({ meshName: cmd.meshName, label: cmd.label }));
          break;
        case 'camera_focus':
          dispatch(requestCameraCommand({ action: 'focus', meshName: cmd.meshName }));
          break;
        case 'select_mesh':
          dispatch(selectMesh(cmd.meshName));
          break;
        case 'clear_highlights':
          dispatch(clearAgentHighlights());
          break;
        case 'open_report':
          dispatch(reportOpened(cmd.reportId));
          break;
        default:
          break;
      }
    }
  };

/**
 * Light up the parts a new report names, on the twin it belongs to. The camera
 * is not moved: an alert must not take the view away from the operator.
 *
 * @param {{assetId: string, targets?: Array<{meshName: string, label?: string}>}} alert
 */
export const highlightAlertTargets = (alert) => (dispatch, getState) => {
  if (!alert?.assetId || getState().agent.activeAssetId !== alert.assetId) return;
  for (const t of alert.targets ?? []) dispatch(addAgentHighlight(t.meshName, { durationMs: 30_000 }));
};

/**
 * Show a report's parts on the model: highlight all, frame the first.
 *
 * @param {Array<{meshName: string, label?: string|null}>} targets
 */
export const showTargets = (targets) => (dispatch) => {
  if (!targets?.length) return;
  dispatch(clearAgentHighlights());
  for (const t of targets) dispatch(addAgentHighlight(t.meshName));
  dispatch(requestCameraCommand({ action: 'focus', meshName: targets[0].meshName }));
  dispatch(pointerSet({ meshName: targets[0].meshName, label: targets[0].label ?? targets[0].meshName }));
};
