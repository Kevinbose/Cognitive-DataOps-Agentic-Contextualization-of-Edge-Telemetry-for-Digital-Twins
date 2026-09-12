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
export default defineConfig({
  plugins: [react(), tailwindcss()],

  server: {
    port: 5173,
    /**
     * Proxy API and asset traffic to the Express server so the browser sees a
     * single origin in development.
     *
     * This matters more than convenience: `/static/**` serves the `.glb`
     * meshes, and routing them through the same origin avoids CORS
     * preflight on every range request a streaming glTF loader makes.
     */
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
      },
      '/static': {
        target: 'http://localhost:5000',
        changeOrigin: true,
      },
    },
  },

  build: {
    // three.js and drei are large; raising the warning ceiling keeps the build
    // log readable instead of flagging an expected, unavoidable chunk size.
    chunkSizeWarningLimit: 1500,
  },
});
