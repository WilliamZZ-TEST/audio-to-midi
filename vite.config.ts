import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  optimizeDeps: {
    include: ['long', 'seedrandom'],
    exclude: ['onnxruntime-web'],
  },
  build: {
    target: 'esnext',
  },
});
