import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// The site is published as a GitHub Pages project page, which lives under
// https://<user>.github.io/<repo>/, so every asset URL needs that prefix.
// Set BASE_PATH=/ when targeting a user page, a custom domain or a local file.
export default defineConfig({
  base: process.env.BASE_PATH ?? '/camera-sim/',
  plugins: [vue()]
});
