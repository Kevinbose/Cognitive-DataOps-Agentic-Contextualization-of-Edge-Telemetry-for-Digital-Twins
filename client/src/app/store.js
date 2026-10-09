/**
 * @file Redux store.
 *
 * @module app/store
 */

import { configureStore } from '@reduxjs/toolkit';
import { setupListeners } from '@reduxjs/toolkit/query';

import { apiSlice } from '../services/apiSlice.js';
import agentReducer from '../features/agent/agentSlice.js';
import telemetryReducer from '../features/telemetry/telemetrySlice.js';
import twinViewerReducer from '../features/twin-viewer/twinViewerSlice.js';

export const store = configureStore({
  reducer: {
    [apiSlice.reducerPath]: apiSlice.reducer,
    twinViewer: twinViewerReducer,
    telemetry: telemetryReducer,
    agent: agentReducer,
  },

  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      /**
       * Two unavoidable non-serialisable values pass through RTK Query:
       *   · `meta.arg.originalArgs` — the `File` / `FormData` on upload mutations.
       *   · `meta.baseQueryMeta.request|response` — the `fetch` Request and
       *     Response objects RTK Query attaches to every fulfilled action.
       *
       * Both are exempted by path rather than disabling the check wholesale,
       * so a genuinely non-serialisable value entering `twinViewer` (a
       * `THREE.Object3D`, say) still trips the warning. That guard matters
       * here: the viewer slice sits next to a scene graph full of them.
       */
      serializableCheck: {
        ignoredActionPaths: [
          'meta.arg.originalArgs',
          'meta.arg.originalArgs.file',
          'meta.baseQueryMeta.request',
          'meta.baseQueryMeta.response',
        ],
        // The live series and spectra are large, change four times a second and
        // hold only numbers. The dev-only serialisability and immutability
        // checks would walk them on every dispatch for no benefit.
        ignoredPaths: ['telemetry.series', 'telemetry.spectra'],
      },
      immutableCheck: {
        ignoredPaths: ['telemetry.series', 'telemetry.spectra'],
      },
    }).concat(apiSlice.middleware),

  devTools: import.meta.env.DEV,
});

// Enables `refetchOnFocus` / `refetchOnReconnect` declared on the API slice.
setupListeners(store.dispatch);

export default store;
