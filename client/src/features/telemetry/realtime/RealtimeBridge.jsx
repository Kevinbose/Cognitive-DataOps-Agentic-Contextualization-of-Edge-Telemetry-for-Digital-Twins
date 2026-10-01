/**
 * @file Connects the socket to the store. Mounted once, renders nothing.
 *
 * Every socket event becomes at most one Redux action, and the high-rate one
 * (`telemetry:batch`) is coalesced so the store sees four updates a second no
 * matter how many samples the devices send. `LiveAnnouncer` is its companion:
 * it speaks the state changes that the slice queues.
 *
 * @module features/telemetry/realtime/RealtimeBridge
 */

import { useEffect } from 'react';

import { useAppDispatch } from '../../../app/hooks.js';
import { apiSlice } from '../../../services/apiSlice.js';
import {
  ackReceived,
  connectionChanged,
  deviceUpdated,
  samplesReceived,
  snapshotReceived,
  spectrumReceived,
} from '../telemetrySlice.js';
import { getSocket } from './socketClient.js';

/** Redux gets samples this often: 4 Hz. */
const FLUSH_INTERVAL_MS = 250;

/**
 * @returns {null}
 */
export function RealtimeBridge() {
  const dispatch = useAppDispatch();

  useEffect(() => {
    const socket = getSocket();

    /** @type {any[]} */
    let pending = [];
    const flush = () => {
      if (pending.length === 0) return;
      const batch = pending;
      pending = [];
      dispatch(samplesReceived(batch));
    };
    const timer = setInterval(flush, FLUSH_INTERVAL_MS);

    const handlers = {
      connect: () => dispatch(connectionChanged('live')),
      disconnect: () => dispatch(connectionChanged('reconnecting')),
      connect_error: () => dispatch(connectionChanged('reconnecting')),
      snapshot: (snapshot) => dispatch(snapshotReceived(snapshot)),
      'telemetry:batch': (samples) => {
        for (const sample of samples) pending.push(sample);
      },
      'spectrum:frame': (frame) => dispatch(spectrumReceived(frame)),
      'device:update': (device) => dispatch(deviceUpdated(device)),
      'device:ack': (ack) => {
        dispatch(ackReceived(ack));
        // A scenario change alters what the simulated device reports about itself.
        if (ack.ok && ack.name === 'scenario') {
          dispatch(apiSlice.util.invalidateTags([{ type: 'Sim', id: ack.machineId }]));
        }
      },
      // Another tab (or the agent, later) changed this asset's bindings.
      'twin:invalidate': ({ assetId }) =>
        dispatch(
          apiSlice.util.invalidateTags([
            { type: 'TwinScene', id: assetId },
            { type: 'Asset', id: assetId },
          ]),
        ),
    };

    for (const [event, handler] of Object.entries(handlers)) socket.on(event, handler);

    // The library gives up after its own retry policy; surface that as offline.
    const onReconnectFailed = () => dispatch(connectionChanged('offline'));
    socket.io.on('reconnect_failed', onReconnectFailed);

    socket.connect();
    if (socket.connected) dispatch(connectionChanged('live'));

    return () => {
      clearInterval(timer);
      for (const [event, handler] of Object.entries(handlers)) socket.off(event, handler);
      socket.io.off('reconnect_failed', onReconnectFailed);
      socket.disconnect();
    };
  }, [dispatch]);

  return null;
}

export default RealtimeBridge;
