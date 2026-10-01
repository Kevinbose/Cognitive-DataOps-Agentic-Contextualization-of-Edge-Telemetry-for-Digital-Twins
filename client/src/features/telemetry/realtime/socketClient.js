/**
 * @file The one Socket.io connection.
 *
 * A module-level singleton created with `autoConnect: false`. React StrictMode
 * runs every effect twice in development (mount, unmount, mount), so anything
 * that created or destroyed the connection inside an effect would open two
 * sockets and close one. Here the connection is created once, and effects only
 * `connect()` and `disconnect()` it, both of which are idempotent.
 *
 * The URL is the page's own origin: in development Vite proxies `/socket.io` to
 * the API, so the browser sees one origin and the server's origin check sees the
 * console's own address.
 *
 * @module features/telemetry/realtime/socketClient
 */

import { useEffect } from 'react';
import { io } from 'socket.io-client';

/** @type {import('socket.io-client').Socket|null} */
let socket = null;

/**
 * @returns {import('socket.io-client').Socket} The shared socket (not yet connected on first call).
 */
export function getSocket() {
  if (!socket) {
    socket = io({
      autoConnect: false,
      // Websocket first: polling then upgrading is wasted round trips on a LAN.
      transports: ['websocket', 'polling'],
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });
  }
  return socket;
}

/**
 * Receive `twin:invalidate` for one asset while a page is showing it.
 *
 * Rooms are server-side state and are LOST when the socket reconnects, so the
 * subscription is re-sent on every `connect`, not just on mount.
 *
 * @param {string|undefined} assetId
 * @returns {void}
 */
export function useAssetRoom(assetId) {
  useEffect(() => {
    if (!assetId) return undefined;

    const current = getSocket();
    const join = () => current.emit('subscribe:asset', assetId);

    if (current.connected) join();
    current.on('connect', join);

    return () => {
      current.off('connect', join);
      current.emit('unsubscribe:asset', assetId);
    };
  }, [assetId]);
}
