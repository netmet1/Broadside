/**
 * The one job of this config: turn `render.tsx` into something node can run.
 *
 * The help prose is TSX that imports through the `@/` alias, and node runs
 * neither. Vite is already here for the app, so the PDF build borrows it for a
 * single-file SSR bundle rather than adding a compiler of its own. React and
 * react-dom stay external (an SSR build leaves dependencies alone), so the
 * bundle is the help content and nothing else.
 *
 * Deliberately separate from the app's `vite.config.ts`: no Tailwind, no HTML
 * entry, no dev server. The PDF wants the elements, not the stylesheet.
 */

import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  root: repoRoot,
  logLevel: "warn",
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL("../../src", import.meta.url)) } },
  build: {
    ssr: "scripts/help-pdf/render.tsx",
    // Inside node_modules so it is already ignored by git and by every tool
    // that walks the tree.
    outDir: "node_modules/.cache/help-pdf",
    emptyOutDir: true,
    target: "node22",
    minify: false,
    rollupOptions: { output: { entryFileNames: "render.mjs" } },
  },
});
