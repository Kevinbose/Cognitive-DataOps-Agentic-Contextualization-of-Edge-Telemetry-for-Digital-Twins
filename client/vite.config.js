import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Vite configuration for the Cognitive DataOps console.
 *
 * Tailwind v4 is wired through its official Vite plugin rather than PostCSS —
 * v4 moved theme configuration into CSS (`@theme`), so there is no
 * `tailwind.config.js` in this project by design.
 */

/**
 * The API listens on the IPv4 loopback address. Targeting `127.0.0.1` rather
 * than `localhost` matters on Windows: Node resolves `localhost` to `::1`
 * first, where nothing is listening, and the proxy then fails with
 * ECONNREFUSED even though the server is up.
 */
const API_ORIGIN = 'http://127.0.0.1:5000';

export default defineConfig({
  plugins: [react(), tailwindcss()],

  server: {
    port: 5173,
    /**
     * Proxy API, asset and realtime traffic to the Express server so the
     * browser sees a single origin in development.
     *
     * This matters more than convenience: `/static/**` serves the `.glb`
     * meshes, and routing them through the same origin avoids CORS
     * preflight on every range request a streaming glTF loader makes. The
     * websocket route needs `ws: true` or the Socket.io upgrade is refused.
     */
    proxy: {
      '/api': {
        target: API_ORIGIN,
        changeOrigin: true,
      },
      '/static': {
        target: API_ORIGIN,
        changeOrigin: true,
      },
      '/socket.io': {
        target: API_ORIGIN,
        changeOrigin: true,
        ws: true,
      },
    },
  },

  build: {
    // three.js and drei are large; raising the warning ceiling keeps the build
    // log readable instead of flagging an expected, unavoidable chunk size.
    chunkSizeWarningLimit: 1500,
  },
});
