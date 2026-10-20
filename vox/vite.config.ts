import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Emits the precache manifest consumed by public/sw.js so the PWA shell
// (all hashed bundles incl. the ORT wasm Vite emits) is available offline after first load.
function precacheManifest(): Plugin {
  return {
    name: 'zvox-precache',
    generateBundle(_o, bundle) {
      const files = Object.keys(bundle).filter((f) => !f.endsWith('.map'));
      const extra = ['./', 'index.html', 'manifest.webmanifest', 'icon.svg'];
      this.emitFile({ type: 'asset', fileName: 'precache.json',
        source: JSON.stringify({ version: Date.now(), files: [...extra, ...files] }) });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), precacheManifest()],
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  server: {
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
  },
  test: { environment: 'node', testTimeout: 60000, exclude: ['tests/e2e/**', 'node_modules/**'] },
} as any);
