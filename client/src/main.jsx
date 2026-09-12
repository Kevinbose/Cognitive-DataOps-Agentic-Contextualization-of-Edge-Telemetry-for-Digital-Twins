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
import { router } from './router/routes.jsx';
import './index.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Provider store={store}>
      <RouterProvider router={router} />
    </Provider>
  </StrictMode>,
);
