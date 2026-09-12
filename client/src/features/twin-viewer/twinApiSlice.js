/**
 * @file Twin-scene and sensor-binding endpoints.
 *
 * @module features/twin-viewer/twinApiSlice
 */

import { apiSlice, unwrap } from '../../services/apiSlice.js';

/**
 * @typedef {object} ActiveBinding
 * @property {string} _id
 * @property {string} sensorId
 * @property {'temperature'|'vibration'|'rpm'|'pressure'|'current'|'generic'} sensorType
 * @property {string|null} boundBy
 * @property {string} boundAt
 * @property {string|null} notes
 */

/**
 * @typedef {object} SceneMeshNode
 * @property {string} _id
 * @property {string} meshName - Raw glTF node name; the join key into the scene graph.
 * @property {string|null} displayName
 * @property {string} label - `displayName || meshName`.
 * @property {boolean} isMapped
 * @property {ActiveBinding|null} activeBinding
 */

/**
 * @typedef {object} TwinScene
 * @property {import('../assets/assetsApiSlice.js').Asset} asset
 * @property {string|null} modelUrl - Cache-busted `/static/...glb?v=N`.
 * @property {SceneMeshNode[]} meshNodes
 * @property {{registeredNodes: number, mappedNodes: number}} stats
 */

export const twinApiSlice = apiSlice.injectEndpoints({
  endpoints: (builder) => ({
    /**
     * The aggregated viewer payload: asset, model URL, and every registered
     * mesh node with its active binding already joined server-side.
     */
    getTwinScene: builder.query({
      query: (assetId) => `/assets/${assetId}/scene`,
      transformResponse: unwrap,
      providesTags: (_result, _error, assetId) => [{ type: 'TwinScene', id: assetId }],
    }),

    /**
     * Save a sensor mapping — the core Phase 2 write.
     *
     * Addressed by mesh NAME because that is all the 3D viewer knows at click
     * time (`event.object.name`). The mesh name must be percent-encoded: real
     * glTF names contain slashes.
     */
    saveSensorBinding: builder.mutation({
      query: ({ assetId, meshName, ...body }) => ({
        url: `/assets/${assetId}/mesh-nodes/by-name/${encodeURIComponent(meshName)}/sensor-binding`,
        method: 'PUT',
        body,
      }),
      transformResponse: unwrap,
      // One tag covers it: the scene refetch updates the sidebar, the mesh
      // list, the stats, and the 3D highlight simultaneously.
      invalidatesTags: (_r, _e, { assetId }) => [
        { type: 'TwinScene', id: assetId },
        { type: 'Asset', id: assetId },
      ],
    }),

    /** Retire a binding. The mesh becomes available for a new sensor. */
    deleteSensorBinding: builder.mutation({
      query: ({ bindingId }) => ({ url: `/sensor-bindings/${bindingId}`, method: 'DELETE' }),
      transformResponse: unwrap,
      invalidatesTags: (_r, _e, { assetId }) => [
        { type: 'TwinScene', id: assetId },
        { type: 'Asset', id: assetId },
      ],
    }),

    /** Binding list, optionally including retired rows (the rebind history). */
    getSensorBindings: builder.query({
      query: ({ assetId, includeInactive = false }) => ({
        url: `/assets/${assetId}/sensor-bindings`,
        params: { includeInactive },
      }),
      transformResponse: unwrap,
      providesTags: (_result, _error, { assetId }) => [{ type: 'TwinScene', id: assetId }],
    }),

    /** Remove a registered mesh node entirely (also retires its binding). */
    deleteMeshNode: builder.mutation({
      query: ({ meshNodeId }) => ({ url: `/mesh-nodes/${meshNodeId}`, method: 'DELETE' }),
      transformResponse: unwrap,
      invalidatesTags: (_r, _e, { assetId }) => [{ type: 'TwinScene', id: assetId }],
    }),
  }),
});

export const {
  useGetTwinSceneQuery,
  useSaveSensorBindingMutation,
  useDeleteSensorBindingMutation,
  useGetSensorBindingsQuery,
  useDeleteMeshNodeMutation,
} = twinApiSlice;
