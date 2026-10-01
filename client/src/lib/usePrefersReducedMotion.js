/**
 * @file Reactive `prefers-reduced-motion`.
 *
 * CSS handles the DOM (a global rule in `index.css` stills every animation), but
 * the 3D pulse is driven from JavaScript, so it has to ask. The value is live:
 * toggling the operating-system setting takes effect without a reload.
 *
 * @module lib/usePrefersReducedMotion
 */

import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

/**
 * @returns {boolean} True when the user has asked for reduced motion.
 */
export function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(QUERY).matches,
  );

  useEffect(() => {
    const media = window.matchMedia(QUERY);
    /** @param {MediaQueryListEvent} event */
    const onChange = (event) => setReduced(event.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  return reduced;
}

export default usePrefersReducedMotion;
