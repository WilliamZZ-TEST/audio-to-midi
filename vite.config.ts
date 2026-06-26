import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  optimizeDeps: {
    include: ['long'],
    exclude: ['onnxruntime-web', '@tensorflow/tfjs'],
  },
  build: {
    target: 'esnext',
  },
});
