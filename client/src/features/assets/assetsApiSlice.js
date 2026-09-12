/**
 * @file Asset endpoints, injected into the shared API slice.
 *
 * @module features/assets/assetsApiSlice
 */

import { apiSlice, unwrap } from '../../services/apiSlice.js';

/**
 * @typedef {object} FileArtifact
 * @property {string} filename
 * @property {string} originalName
 * @property {string} mimeType
 * @property {number} sizeBytes
 * @property {string} storageKey
 * @property {string} checksum
 * @property {string} uploadedAt
 */

/**
 * @typedef {object} Asset
 * @property {string} _id
 * @property {string} name
 * @property {string} uploader
 * @property {'stp'|'step'|'iges'|'other'} sourceType
 * @property {'pending_conversion'|'converted'|'mapped'|'failed'} status
 * @property {FileArtifact|null} originalFile
 * @property {FileArtifact|null} convertedFile
 * @property {number} version
 * @property {boolean} isRenderable
 * @property {{partCount: number|null, units: string|null, notes: string|null}} metadata
 * @property {string} createdAt
 * @property {string} updatedAt
 */

export const assetsApiSlice = apiSlice.injectEndpoints({
  endpoints: (builder) => ({
    /**
     * Paginated asset list for the dashboard.
     * Returns the full envelope (not just `data`) because the caller needs
     * `meta` for pagination alongside the rows.
     */
    getAssets: builder.query({
      query: ({ status, search, page = 1, limit = 20 } = {}) => ({
        url: '/assets',
        params: {
          ...(status ? { status } : {}),
          ...(search ? { search } : {}),
          page,
          limit,
        },
      }),
      transformResponse: (response) => ({ items: response.data, meta: response.meta }),
      providesTags: (result) =>
        result
          ? [
              ...result.items.map((asset) => ({ type: /** @type {const} */ ('Asset'), id: asset._id })),
              { type: /** @type {const} */ ('Asset'), id: 'LIST' },
            ]
          : [{ type: /** @type {const} */ ('Asset'), id: 'LIST' }],
    }),

    /** Single asset metadata. */
    getAssetById: builder.query({
      query: (assetId) => `/assets/${assetId}`,
      transformResponse: unwrap,
      providesTags: (_result, _error, assetId) => [{ type: 'Asset', id: assetId }],
    }),

    /**
     * Create an asset, optionally with its source CAD file.
     * Body is `FormData`; `fetchBaseQuery` sets the multipart boundary itself,
     * so no Content-Type header is passed here (setting one breaks the boundary).
     */
    createAsset: builder.mutation({
      query: (formData) => ({ url: '/assets', method: 'POST', body: formData }),
      transformResponse: unwrap,
      invalidatesTags: [{ type: 'Asset', id: 'LIST' }],
    }),

    /** Attach or replace the web-ready `.glb`. Promotes status to `converted`. */
    uploadConvertedFile: builder.mutation({
      query: ({ assetId, file }) => {
        const body = new FormData();
        body.append('convertedFile', file);
        return { url: `/assets/${assetId}/converted-file`, method: 'POST', body };
      },
      transformResponse: unwrap,
      // Both the row and the viewer payload change when geometry is replaced.
      invalidatesTags: (_r, _e, { assetId }) => [
        { type: 'Asset', id: assetId },
        { type: 'Asset', id: 'LIST' },
        { type: 'TwinScene', id: assetId },
      ],
    }),

    /** Attach or replace the raw CAD file. */
    uploadOriginalFile: builder.mutation({
      query: ({ assetId, file }) => {
        const body = new FormData();
        body.append('originalFile', file);
        return { url: `/assets/${assetId}/original-file`, method: 'POST', body };
      },
      transformResponse: unwrap,
      invalidatesTags: (_r, _e, { assetId }) => [
        { type: 'Asset', id: assetId },
        { type: 'Asset', id: 'LIST' },
      ],
    }),

    /** Update descriptive fields. */
    updateAsset: builder.mutation({
      query: ({ assetId, ...patch }) => ({
        url: `/assets/${assetId}`,
        method: 'PATCH',
        body: patch,
      }),
      transformResponse: unwrap,
      invalidatesTags: (_r, _e, { assetId }) => [
        { type: 'Asset', id: assetId },
        { type: 'Asset', id: 'LIST' },
      ],
    }),

    /** Soft delete, cascading to mesh nodes and bindings. */
    deleteAsset: builder.mutation({
      query: (assetId) => ({ url: `/assets/${assetId}`, method: 'DELETE' }),
      transformResponse: unwrap,
      invalidatesTags: (_r, _e, assetId) => [
        { type: 'Asset', id: assetId },
        { type: 'Asset', id: 'LIST' },
        { type: 'TwinScene', id: assetId },
      ],
    }),
  }),
});

export const {
  useGetAssetsQuery,
  useGetAssetByIdQuery,
  useCreateAssetMutation,
  useUploadConvertedFileMutation,
  useUploadOriginalFileMutation,
  useUpdateAssetMutation,
  useDeleteAssetMutation,
} = assetsApiSlice;
