import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/data/portfolio-summary.json': 'http://127.0.0.1:8080',
      '/data/hermes-cron-status.json': 'http://127.0.0.1:8080',
      '/data/structured-products-enrichment.json': 'http://127.0.0.1:8080',
      '/api': 'http://127.0.0.1:8080',
    },
  },
});
