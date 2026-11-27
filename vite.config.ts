import { defineConfig } from 'vite';

export default defineConfig({
  base: './', // relative paths, so the build works on any static host or subfolder
  build: { target: 'es2022' },
});
