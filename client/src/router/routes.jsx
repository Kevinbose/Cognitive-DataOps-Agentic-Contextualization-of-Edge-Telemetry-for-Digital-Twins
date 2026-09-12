/**
 * @file Route table.
 *
 * The twin viewer is deliberately its own route (`/assets/:assetId/twin`)
 * rather than a modal: the guidelines require that stateful UI be deep-linkable,
 * and an operator needs to be able to send a colleague a link to the exact twin
 * they are looking at.
 *
 * @module router/routes
 */

import { createBrowserRouter, Navigate } from 'react-router-dom';

import ConsoleShell from '../components/layout/ConsoleShell.jsx';
import AssetDashboardPage from '../features/assets/pages/AssetDashboardPage.jsx';
import AssetUploadPage from '../features/assets/pages/AssetUploadPage.jsx';
import AssetDetailPage from '../features/assets/pages/AssetDetailPage.jsx';
import TwinViewerPage from '../features/twin-viewer/pages/TwinViewerPage.jsx';
import MappingConfigPage from '../features/mapping/pages/MappingConfigPage.jsx';

/**
 * Wrap a page in the console chrome.
 * @param {import('react').ReactNode} element
 * @returns {import('react').JSX.Element}
 */
const shell = (element) => <ConsoleShell>{element}</ConsoleShell>;

export const router = createBrowserRouter([
  { path: '/', element: <Navigate to="/assets" replace /> },
  { path: '/assets', element: shell(<AssetDashboardPage />) },
  { path: '/assets/new', element: shell(<AssetUploadPage />) },
  { path: '/assets/:assetId', element: shell(<AssetDetailPage />) },

  // The viewer opts out of `ConsoleShell`'s padded container: the canvas is
  // full-bleed, and a max-width wrapper would letterbox the 3D viewport.
  { path: '/assets/:assetId/twin', element: <TwinViewerPage /> },

  { path: '/assets/:assetId/mapping', element: shell(<MappingConfigPage />) },

  {
    path: '*',
    element: shell(
      <div className="py-20 text-center">
        <h2 className="display-page mb-3 text-ink">404</h2>
        <p className="font-sans text-[13px] text-ink-muted">
          That route does not exist in this console.
        </p>
      </div>,
    ),
  },
]);

export default router;
