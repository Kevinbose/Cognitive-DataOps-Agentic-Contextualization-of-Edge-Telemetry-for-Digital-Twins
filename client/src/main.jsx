/**
 * @file Client entry point.
 *
 * `<Provider>` wraps the entire tree — including, crucially, every `<Canvas>`
 * mounted deeper in the app. React Context propagates across React Three
 * Fiber's separate reconciler, which is precisely what lets a mesh click
 * inside WebGL dispatch to the same store the DOM sidebar reads from.
 *
 * @module main
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { RouterProvider } from 'react-router-dom';

import { store } from './app/store.js';
import LiveAnnouncer from './features/telemetry/realtime/LiveAnnouncer.jsx';
import RealtimeBridge from './features/telemetry/realtime/RealtimeBridge.jsx';
import { router } from './router/routes.jsx';

/*
 * Self-hosted fonts, latin subset only. Archivo's `wdth` file is the one that
 * makes `font-stretch: 112.5%` actually work; the default wght-only file would
 * silently ignore it. Plex Sans carries the interface, Plex Mono every
 * identifier and ticking number. Weights are limited to the ones in use.
 */
import '@fontsource-variable/archivo/wdth.css';
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import './index.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Provider store={store}>
      {/* Mounted once, outside the router: one socket for the whole app, and
          one live region. Neither renders anything visible. */}
      <RealtimeBridge />
      <LiveAnnouncer />
      <RouterProvider router={router} />
    </Provider>
  </StrictMode>,
);
