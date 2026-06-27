import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const BACKEND = 'http://localhost:8000';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/auth': BACKEND,
      '/account': BACKEND,
      '/files': BACKEND,
      '/file': BACKEND,
      '/directories': BACKEND,
      '/d': BACKEND,
      '/links': BACKEND,
      '/dropbox-links': BACKEND,
      '/dropbox': BACKEND,
      '/keys': BACKEND,
      '/users': BACKEND,
      '/admin': BACKEND,
      '/audit': BACKEND,
    },
  },
});
