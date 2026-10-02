import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Deliberately separate from the application's config. These aliases are never
// included by the production build or the normal dev workflow.
export default defineConfig({
  root: import.meta.dirname,
  base: "/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: "@clerk/react/internal", replacement: path.join(import.meta.dirname, "clerk-internal.ts") },
      { find: "@clerk/react", replacement: path.join(import.meta.dirname, "clerk.tsx") },
      { find: "@", replacement: path.resolve(import.meta.dirname, "../../src") },
    ],
    dedupe: ["react", "react-dom"],
  },
  server: {
    host: "127.0.0.1",
    port: 4179,
    strictPort: true,
    fs: { allow: [path.resolve(import.meta.dirname, "../../../..")] },
  },
});