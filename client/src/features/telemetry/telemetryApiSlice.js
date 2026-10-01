/**
 * @file Endpoints for metadata and device control.
 *
 * Live telemetry itself does NOT come through here: it arrives over the socket
 * and lives in `telemetrySlice`. These are the request/response endpoints that
 * sit beside it.
 *
 * @module features/telemetry/telemetryApiSlice
 */

import { apiSlice, unwrap } from '../../services/apiSlice.js';

/**
 * @typedef {object} ServerMeta
 * @property {string[]} sensorTypes - Valid `sensorType` values, straight from the schema.
 * @property {string[]} meshObjectTypes
 * @property {{ingestion: boolean, deviceCommands: boolean}} features
 * @property {string} siteId
 */

/**
 * @typedef {object} SimState
 * @property {string} machineId
 * @property {string|null} scenario - What the simulated device reports it is running.
 * @property {number|null} ramp - Progress through the fault ramp, 0 to 1.
 * @property {number|null} rampSec
 * @property {number|null} reportedAt
 * @property {{scenario: string, rampSec: number|null, at: number}|null} commanded
 */

export const telemetryApiSlice = apiSlice.injectEndpoints({
  endpoints: (builder) => ({
    /**
     * Enumerations and feature flags. The client keeps no copy of the sensor
     * type list, so adding a type on the server is the only edit needed.
     */
    getMeta: builder.query({
      query: () => '/meta',
      transformResponse: unwrap,
      // Changes only with a server restart.
      keepUnusedDataFor: 3600,
    }),

    /**
     * Send a command to a device (fault injection, interval, ping).
     * `202 Accepted`: the outcome arrives later as a `device:ack` socket event.
     */
    sendDeviceCommand: builder.mutation({
      query: ({ machineId, name, args }) => ({
        url: `/devices/${machineId}/commands`,
        method: 'POST',
        body: { name, args: args ?? {} },
      }),
      transformResponse: unwrap,
    }),

    /**
     * Add a discovered machine to a twin. The server then broadcasts the device
     * with its new `assetId`, which is what moves it between the lists, so there
     * is nothing to refetch here.
     */
    addMachine: builder.mutation({
      query: ({ assetId, machineId }) => ({
        url: `/assets/${assetId}/machines`,
        method: 'POST',
        body: { machineId },
      }),
      transformResponse: unwrap,
    }),

    /**
     * Take a machine off a twin. The server also retires the bindings of its
     * channels, so the scene (which carries the bindings) is refetched.
     */
    removeMachine: builder.mutation({
      query: ({ assetId, machineId }) => ({
        url: `/assets/${assetId}/machines/${machineId}`,
        method: 'DELETE',
      }),
      transformResponse: unwrap,
      invalidatesTags: (_r, _e, { assetId }) => [
        { type: 'TwinScene', id: assetId },
        { type: 'Asset', id: assetId },
      ],
    }),

    /**
     * Ground truth of a SIMULATED device, for the fault-injection panel only.
     * Never used by anything that stands in for the diagnosis agent.
     */
    getSimState: builder.query({
      query: (machineId) => `/devices/${machineId}/sim`,
      transformResponse: unwrap,
      providesTags: (_result, _error, machineId) => [{ type: 'Sim', id: machineId }],
    }),
  }),
});

export const {
  useGetMetaQuery,
  useSendDeviceCommandMutation,
  useGetSimStateQuery,
  useAddMachineMutation,
  useRemoveMachineMutation,
} = telemetryApiSlice;
