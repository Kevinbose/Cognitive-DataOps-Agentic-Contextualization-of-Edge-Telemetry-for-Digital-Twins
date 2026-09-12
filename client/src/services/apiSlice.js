/**
 * @file The single RTK Query API instance.
 *
 * One `createApi` for the whole app; features attach their own endpoints via
 * `apiSlice.injectEndpoints()`. That keeps a single normalised cache and one
 * middleware registration, while letting each feature folder own its queries.
 *
 * @module services/apiSlice
 */

import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';

/**
 * Unwrap the server's success envelope.
 *
 * Every backend response is `{ success, data, message, meta? }`. Components
 * only ever want `data`, so unwrapping happens once here rather than in every
 * `useQuery` call site.
 *
 * @template T
 * @param {{ data: T }} response - Raw envelope from the API.
 * @returns {T} The payload.
 */
const unwrap = (response) => response.data;

/**
 * Extract a human-readable message from an RTK Query error.
 *
 * The backend always sends `{ success: false, message, errors? }`, but network
 * failures and proxy errors do not — this normalises both into one string that
 * a component can render without branching.
 *
 * @param {unknown} error - The `error` field from an RTK Query hook.
 * @returns {string} A message safe to display.
 */
export function getErrorMessage(error) {
  if (!error) return '';
  if (typeof error === 'string') return error;

  const data = /** @type {{ data?: { message?: string, errors?: Array<{field: string, message: string}> } }} */ (
    error
  )?.data;

  if (data?.errors?.length) {
    // Field errors are more actionable than the generic wrapper message.
    return data.errors.map((issue) => `${issue.field}: ${issue.message}`).join(' · ');
  }
  if (data?.message) return data.message;

  const status = /** @type {{ status?: number | string }} */ (error)?.status;
  if (status === 'FETCH_ERROR') return 'Cannot reach the API. Is the server running on :5000?';

  return `Request failed${status ? ` (${status})` : ''}`;
}

/**
 * Base API slice. All endpoints are injected by feature slices.
 *
 * `/api/v1` is a same-origin path: Vite proxies it to the Express server in
 * development, so there is no CORS preflight and no environment-specific base
 * URL to configure.
 */
export const apiSlice = createApi({
  reducerPath: 'api',
  baseQuery: fetchBaseQuery({ baseUrl: '/api/v1' }),

  /**
   * Cache tags.
   *
   * `TwinScene` is tagged per-asset and is the single source of truth for the
   * viewer: any mutation touching an asset's mappings invalidates exactly that
   * one tag, and the sidebar, 3D highlight, and stats all re-derive from the
   * refetched payload. No manual cache patching anywhere in the app.
   */
  tagTypes: ['Asset', 'TwinScene'],

  // Refetch when the user returns to the tab — an operator leaving a twin open
  // on a second monitor should not be looking at an hour-old mapping table.
  refetchOnFocus: true,
  refetchOnReconnect: true,

  endpoints: () => ({}),
});

export { unwrap };
export default apiSlice;
