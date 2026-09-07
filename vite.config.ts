import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import { defineConfig } from 'vite'

// GitHub Pages serves project sites under /<repo>/. The deploy workflow sets
// VITE_BASE_PATH; local dev and other hosts fall back to '/'.
export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? '/',
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
  ],
})
