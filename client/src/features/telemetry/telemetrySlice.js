/**
 * @file Live telemetry state.
 *
 * ## Why this is its own slice, and NOT in the RTK Query cache
 *
 * The inspector's form re-seeds itself in an effect keyed on the scene's mesh
 * nodes (`registered`, `activeBinding`). If live values were written into the
 * cached `TwinScene`, those objects would change on every tick and the effect
 * would wipe whatever the operator was typing, twice a second. Live data
 * therefore lives here, and the scene cache stays a stable description of the
 * model and its bindings.
 *
 * ## Update rate
 *
 * The socket delivers samples at the device rate (2 Hz per machine). The
 * `RealtimeBridge` batches them and dispatches `samplesReceived` at 4 Hz, one
 * action per batch, so React re-renders a handful of times per second rather
 * than once per message.
 *
 * ## Announcements
 *
 * A polite live region on a value that changes twice a second would flood a
 * screen reader, so values are never `aria-live`. State CHANGES (connection,
 * a device going offline, a channel entering warn or alarm) are queued here as
 * announcements and spoken once, debounced, by `LiveAnnouncer`.
 *
 * @module features/telemetry/telemetrySlice
 */

import { createSelector, createSlice } from '@reduxjs/toolkit';

/** Shared empty array, so a selector never returns a fresh `[]` and re-renders for nothing. */
const NO_CHANNELS = Object.freeze([]);

/** Points kept per channel for the sparkline (2 minutes at 2 Hz). */
export const SERIES_LENGTH = 240;

const MAX_ACKS = 12;
const MAX_ANNOUNCEMENTS = 8;

/**
 * Consecutive samples a new condition must hold before it is ANNOUNCED.
 *
 * A reading that hovers on a limit crosses it back and forth on noise alone;
 * announcing every crossing would have a screen reader say "warning, alarm,
 * warning, alarm" inside two seconds. Four samples is two seconds at 2 Hz. The
 * visible marker still changes immediately: only the speech is damped.
 */
const ANNOUNCE_DWELL_SAMPLES = 4;

/**
 * @typedef {'connecting'|'live'|'reconnecting'|'offline'} ConnectionState
 */

/**
 * @typedef {object} Sample
 * @property {string} sensorId
 * @property {string} machineId
 * @property {string} key
 * @property {number} value
 * @property {string} unit
 * @property {number} decimals
 * @property {number} ts
 * @property {number} rx
 * @property {'normal'|'warn'|'alarm'} status
 * @property {string} [assetId]
 * @property {string} [meshName]
 */

/**
 * @typedef {object} TelemetryState
 * @property {ConnectionState} connection
 * @property {Record<string, any>} devices - Public device views by machine id.
 * @property {Record<string, Sample>} latest - Newest sample per sensor id.
 * @property {Record<string, number[]>} series - Recent values per sensor id.
 * @property {Record<string, {key: string, ts: number, amp: number[]}>} spectra - Newest frame per machine.
 * @property {any[]} acks - Newest command acknowledgements first.
 * @property {Array<{id: number, text: string}>} announcements - Queued for the live region.
 * @property {number} nextAnnouncementId
 * @property {string|null} bindingDraft - A sensor id the operator picked to bind next.
 * @property {Record<string, {announced: string, candidate: string, count: number}>} statusTrack
 *   Per channel: the condition last announced, and the one now being counted toward announcement.
 */

/** @type {TelemetryState} */
const initialState = {
  connection: 'connecting',
  devices: {},
  latest: {},
  series: {},
  spectra: {},
  acks: [],
  announcements: [],
  nextAnnouncementId: 1,
  bindingDraft: null,
  statusTrack: {},
};

const STATUS_WORD = { normal: 'normal', warn: 'in warning', alarm: 'in alarm' };

/**
 * Queue a sentence for the live region.
 *
 * @param {TelemetryState} state
 * @param {string} text
 * @returns {void}
 */
function announce(state, text) {
  state.announcements.push({ id: state.nextAnnouncementId, text });
  state.nextAnnouncementId += 1;
  if (state.announcements.length > MAX_ANNOUNCEMENTS) state.announcements.shift();
}

/**
 * A channel's display label, for an announcement.
 *
 * @param {TelemetryState} state
 * @param {Sample} sample
 * @returns {string}
 */
function channelLabel(state, sample) {
  const device = state.devices[sample.machineId];
  const channel = device?.channels?.find((candidate) => candidate.key === sample.key);
  return channel?.label ?? sample.key;
}

const telemetrySlice = createSlice({
  name: 'telemetry',
  initialState,
  reducers: {
    /** @param {TelemetryState} state @param {{payload: ConnectionState}} action */
    connectionChanged(state, action) {
      if (state.connection === action.payload) return;
      const previous = state.connection;
      state.connection = action.payload;

      // The first connect is not news; everything after it is.
      if (action.payload === 'live' && previous !== 'connecting') {
        announce(state, 'Live data connection restored');
      } else if (action.payload === 'reconnecting') {
        announce(state, 'Live data connection lost, reconnecting');
      } else if (action.payload === 'offline') {
        announce(state, 'Live data is offline');
      }
    },

    /**
     * The server's first message: everything it knows right now, so a fresh tab
     * is never blank while it waits for the next sample.
     *
     * @param {TelemetryState} state
     * @param {{payload: {devices: any[], latest: Record<string, Sample>, spectra: Record<string, any>}}} action
     */
    snapshotReceived(state, action) {
      const { devices, latest, spectra } = action.payload;

      state.devices = Object.fromEntries(devices.map((device) => [device.machineId, device]));
      state.latest = latest;
      state.spectra = spectra;

      for (const [sensorId, sample] of Object.entries(latest)) {
        if (!state.series[sensorId]) state.series[sensorId] = [sample.value];
      }
    },

    /** @param {TelemetryState} state @param {{payload: any}} action */
    deviceUpdated(state, action) {
      const device = action.payload;
      const previous = state.devices[device.machineId];
      state.devices[device.machineId] = device;

      if (previous && previous.state !== device.state) {
        announce(state, `${device.label} is ${device.state}`);
      }
    },

    /**
     * A coalesced batch of samples. One action, however many samples.
     *
     * @param {TelemetryState} state
     * @param {{payload: Sample[]}} action
     */
    samplesReceived(state, action) {
      for (const sample of action.payload) {
        state.latest[sample.sensorId] = sample;

        const series = (state.series[sample.sensorId] ??= []);
        series.push(sample.value);
        if (series.length > SERIES_LENGTH) series.splice(0, series.length - SERIES_LENGTH);

        // Announce a change of condition, never a change of value, and only
        // once the new condition has held for a couple of seconds.
        const track = state.statusTrack[sample.sensorId];
        if (!track) {
          // The first sample sets the baseline silently.
          state.statusTrack[sample.sensorId] = {
            announced: sample.status,
            candidate: sample.status,
            count: 0,
          };
        } else if (sample.status === track.announced) {
          track.candidate = sample.status;
          track.count = 0;
        } else {
          track.count = sample.status === track.candidate ? track.count + 1 : 1;
          track.candidate = sample.status;
          if (track.count >= ANNOUNCE_DWELL_SAMPLES) {
            track.announced = sample.status;
            track.count = 0;
            announce(
              state,
              `${channelLabel(state, sample)} is ${STATUS_WORD[sample.status] ?? sample.status}`,
            );
          }
        }
      }
    },

    /** @param {TelemetryState} state @param {{payload: {machineId: string, key: string, ts: number, amp: number[]}}} action */
    spectrumReceived(state, action) {
      const { machineId, ...frame } = action.payload;
      state.spectra[machineId] = frame;
    },

    /** @param {TelemetryState} state @param {{payload: any}} action */
    ackReceived(state, action) {
      state.acks.unshift(action.payload);
      if (state.acks.length > MAX_ACKS) state.acks.length = MAX_ACKS;
    },

    /** @param {TelemetryState} state @param {{payload: string}} action */
    announced(state, action) {
      announce(state, action.payload);
    },

    /**
     * Drop announcements up to and including `payload`, once they have been
     * handed to the live region.
     *
     * @param {TelemetryState} state
     * @param {{payload: number}} action
     */
    announcementsConsumed(state, action) {
      state.announcements = state.announcements.filter((item) => item.id > action.payload);
    },

    /**
     * The operator picked a channel to bind ("Bind" on an unbound row). The
     * binding form preselects it once a component is selected.
     *
     * @param {TelemetryState} state
     * @param {{payload: string|null}} action
     */
    bindingDraftSet(state, action) {
      state.bindingDraft = action.payload;
    },
  },
});

export const {
  connectionChanged,
  snapshotReceived,
  deviceUpdated,
  samplesReceived,
  spectrumReceived,
  ackReceived,
  announced,
  announcementsConsumed,
  bindingDraftSet,
} = telemetrySlice.actions;

/* ── Selectors ─────────────────────────────────────────────────────────────── */

/** @param {{telemetry: TelemetryState}} state */
export const selectConnection = (state) => state.telemetry.connection;
/** @param {{telemetry: TelemetryState}} state */
export const selectDevicesMap = (state) => state.telemetry.devices;
/** @param {{telemetry: TelemetryState}} state */
export const selectLatestMap = (state) => state.telemetry.latest;
/** @param {{telemetry: TelemetryState}} state */
export const selectSeriesMap = (state) => state.telemetry.series;
/** @param {{telemetry: TelemetryState}} state */
export const selectSpectra = (state) => state.telemetry.spectra;
/** @param {{telemetry: TelemetryState}} state */
export const selectAcks = (state) => state.telemetry.acks;
/** @param {{telemetry: TelemetryState}} state */
export const selectAnnouncements = (state) => state.telemetry.announcements;
/** @param {{telemetry: TelemetryState}} state */
export const selectBindingDraft = (state) => state.telemetry.bindingDraft;

/** Devices as an array, sorted by machine id. Recomputed only when a device changes. */
export const selectDeviceList = createSelector([selectDevicesMap], (devices) =>
  Object.values(devices).sort((a, b) => a.machineId.localeCompare(b.machineId)),
);

/** `{online, total}` for the connection chip. */
export const selectDeviceSummary = createSelector([selectDeviceList], (devices) => ({
  online: devices.filter((device) => device.state === 'online').length,
  total: devices.length,
}));

/**
 * The channels of one machine's device, in the order the device declared them.
 *
 * @param {string} machineId
 * @returns {(state: {telemetry: TelemetryState}) => any[]}
 */
export const selectChannelsOf = (machineId) => (state) =>
  state.telemetry.devices[machineId]?.channels ?? NO_CHANNELS;

/**
 * The meshes that should wear a warning or alarm tint right now.
 *
 * A channel tints its mesh only while its device is ONLINE. The last value from
 * a device that has gone quiet is not current evidence, and a mesh that stays
 * red because a board lost power would be a lie.
 *
 * Returns `[meshName, 'warn'|'alarm']` pairs, sorted, so two calls with the same
 * meaning compare equal (see `tintsEqual`).
 */
export const selectAlarmTints = createSelector(
  [selectLatestMap, selectDevicesMap],
  (latest, devices) => {
    /** @type {Map<string, 'warn'|'alarm'>} */
    const byMesh = new Map();

    for (const sample of Object.values(latest)) {
      if (!sample.meshName) continue;
      if (sample.status !== 'warn' && sample.status !== 'alarm') continue;
      if (devices[sample.machineId]?.state !== 'online') continue;

      // One mesh, one tint: alarm outranks warn.
      if (byMesh.get(sample.meshName) !== 'alarm') byMesh.set(sample.meshName, sample.status);
    }

    return [...byMesh.entries()].sort(([a], [b]) => a.localeCompare(b));
  },
);

/**
 * Equality for `selectAlarmTints`. The selector rebuilds its array on every
 * 4 Hz batch; this stops the scene re-diffing unless a tint actually changed.
 *
 * @param {Array<[string, string]>} a
 * @param {Array<[string, string]>} b
 * @returns {boolean}
 */
export function tintsEqual(a, b) {
  return a.length === b.length && a.every(([mesh, tone], i) => mesh === b[i][0] && tone === b[i][1]);
}

export default telemetrySlice.reducer;
