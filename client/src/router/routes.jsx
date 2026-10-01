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

import { lazy, Suspense } from 'react';
import { createBrowserRouter, Navigate } from 'react-router-dom';

import ConsoleShell from '../components/layout/ConsoleShell.jsx';
import { LoadingState } from '../components/ui/Feedback.jsx';
import AssetDashboardPage from '../features/assets/pages/AssetDashboardPage.jsx';
import AssetUploadPage from '../features/assets/pages/AssetUploadPage.jsx';
import AssetDetailPage from '../features/assets/pages/AssetDetailPage.jsx';
import PrivacyPage from '../features/legal/pages/PrivacyPage.jsx';
import TermsPage from '../features/legal/pages/TermsPage.jsx';
import MappingConfigPage from '../features/mapping/pages/MappingConfigPage.jsx';
import NotFoundPage from '../features/site/pages/NotFoundPage.jsx';

/**
 * The viewer is the only page that needs three.js, React Three Fiber and drei,
 * which together are over a megabyte. Loading it on demand keeps the registry,
 * the forms and the legal pages light.
 */
const TwinViewerPage = lazy(() => import('../features/twin-viewer/pages/TwinViewerPage.jsx'));

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
  {
    path: '/assets/:assetId/twin',
    element: (
      <Suspense
        fallback={
          <main id="main-content" className="mx-auto max-w-5xl px-6 py-12">
            <h1 className="sr-only">Digital twin</h1>
            <LoadingState variant="page" label="Loading the viewer…" />
          </main>
        }
      >
        <TwinViewerPage />
      </Suspense>
    ),
  },

  { path: '/assets/:assetId/mapping', element: shell(<MappingConfigPage />) },

  { path: '/terms', element: shell(<TermsPage />) },
  { path: '/privacy', element: shell(<PrivacyPage />) },

  { path: '*', element: shell(<NotFoundPage />) },
]);

export default router;
