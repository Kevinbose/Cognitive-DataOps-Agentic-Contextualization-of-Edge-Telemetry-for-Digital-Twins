/**
 * @file Reads from the diagnosis side of the API: agent status, investigations,
 * reports and stored chat threads.
 *
 * Writes do not exist here on purpose: reports are written by the agent through
 * MCP, and chat turns stream through `askAssistant` (a fetch, not a query),
 * because RTK Query has no notion of a server-sent event stream.
 *
 * @module features/agent/agentApiSlice
 */

import { apiSlice, unwrap } from '../../services/apiSlice.js';

export const agentApiSlice = apiSlice.injectEndpoints({
  endpoints: (builder) => ({
    /** Agent reachability (model, retrieval mode) plus detector counters. */
    getAgentStatus: builder.query({
      query: () => '/agent/status',
      transformResponse: unwrap,
      providesTags: ['AgentStatus'],
    }),

    /** Open investigations, newest first, for one twin or the whole plant. */
    getInvestigations: builder.query({
      query: ({ assetId, active = true, limit = 20 } = {}) => ({
        url: '/investigations',
        params: { ...(assetId ? { assetId } : {}), active: String(active), limit },
      }),
      transformResponse: unwrap,
      providesTags: [{ type: 'Investigation', id: 'LIST' }],
    }),

    /** Newest reports, for one twin or the whole plant. */
    getReports: builder.query({
      query: ({ assetId, limit = 10 } = {}) => ({
        url: '/reports',
        params: { ...(assetId ? { assetId } : {}), limit },
      }),
      transformResponse: unwrap,
      providesTags: [{ type: 'Report', id: 'LIST' }],
    }),

    /** One report in full. */
    getReport: builder.query({
      query: (reportId) => `/reports/${reportId}`,
      transformResponse: unwrap,
      providesTags: (_result, _error, reportId) => [{ type: 'Report', id: reportId }],
    }),

    /** A chat thread's transcript, to restore the widget after a reload. */
    getThread: builder.query({
      query: (threadId) => `/assistant/threads/${encodeURIComponent(threadId)}`,
      transformResponse: unwrap,
      keepUnusedDataFor: 0,
    }),
  }),
});

export const {
  useGetAgentStatusQuery,
  useGetInvestigationsQuery,
  useGetReportsQuery,
  useGetReportQuery,
  useGetThreadQuery,
} = agentApiSlice;
