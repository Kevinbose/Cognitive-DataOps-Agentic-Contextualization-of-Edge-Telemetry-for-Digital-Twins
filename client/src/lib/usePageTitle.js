/**
 * @file Per-route document title.
 *
 * The title is what a browser tab, a history entry and a screen reader's page
 * announcement show. One static title for every route makes all of them
 * useless, so each page sets its own: "Asset registry | Cognitive DataOps".
 *
 * @module lib/usePageTitle
 */

import { useEffect } from 'react';

/** Suffix shared by every page. */
const SITE_NAME = 'Cognitive DataOps';

/**
 * Set `document.title` for the lifetime of the calling page.
 *
 * @param {string|undefined|null} title - The page's own name. While it is
 *   falsy (data still loading) the title is just the site name.
 * @returns {void}
 */
export function usePageTitle(title) {
  useEffect(() => {
    document.title = title ? `${title} | ${SITE_NAME}` : SITE_NAME;
  }, [title]);
}

export default usePageTitle;
