/**
 * @file 404, for a route that does not exist.
 *
 * @module features/site/pages/NotFoundPage
 */

import Button from '../../../components/ui/Button.jsx';
import PageHeader from '../../../components/ui/PageHeader.jsx';
import { ArrowLeft } from '../../../components/ui/icons.js';
import { usePageTitle } from '../../../lib/usePageTitle.js';

/**
 * @returns {import('react').JSX.Element}
 */
export function NotFoundPage() {
  usePageTitle('Page not found');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Page not found"
        actions={
          <Button to="/assets" variant="primary" icon={ArrowLeft}>
            Back to registry
          </Button>
        }
      />
      <p className="max-w-prose text-[14px] text-ink-muted">
        That address does not exist in this console. Check the link, or go back to the asset
        registry and start from there.
      </p>
    </div>
  );
}

export default NotFoundPage;
