/**
 * @file A ticking clock for "3 s ago" style labels.
 *
 * Kept to one small hook so only the components that show relative times
 * re-render each second, instead of the whole tree.
 *
 * @module lib/useNow
 */

import { useEffect, useState } from 'react';

/**
 * @param {number} [intervalMs] - Tick period. Default one second.
 * @returns {number} The current time in epoch ms, refreshed every tick.
 */
export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);

  return now;
}

export default useNow;
