/**
 * @file The single polite live region.
 *
 * Numbers that change twice a second are never `aria-live`: a screen reader
 * would read them out continuously. Instead `telemetrySlice` queues a sentence
 * whenever a CONDITION changes (connection, a device going offline, a channel
 * entering warn or alarm, a bind succeeding) and this component speaks them
 * once, debounced so a burst becomes one announcement.
 *
 * @module features/telemetry/realtime/LiveAnnouncer
 */

import { useEffect, useState } from 'react';

import { useAppDispatch, useAppSelector } from '../../../app/hooks.js';
import { announcementsConsumed, selectAnnouncements } from '../telemetrySlice.js';

/** Wait this long after the last queued sentence before speaking. */
const DEBOUNCE_MS = 600;

/**
 * @returns {import('react').JSX.Element}
 */
export function LiveAnnouncer() {
  const dispatch = useAppDispatch();
  const announcements = useAppSelector(selectAnnouncements);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (announcements.length === 0) return undefined;

    // Each new sentence restarts the timer, so a burst is spoken together.
    const timer = setTimeout(() => {
      setMessage(announcements.map((item) => item.text).join('. '));
      dispatch(announcementsConsumed(announcements[announcements.length - 1].id));
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [announcements, dispatch]);

  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {message}
    </div>
  );
}

export default LiveAnnouncer;
