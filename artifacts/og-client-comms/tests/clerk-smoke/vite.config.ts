import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { requireDevelopmentClerk } from "./safety";

const { publishableKey } = requireDevelopmentClerk();
const appPath = path.resolve(import.meta.dirname, "../../src/App.tsx");

export default defineConfig({
  root: import.meta.dirname,
  base: "/",
  // Observe the existing App client only in this isolated server, for cache
  // assertions. No production source, SDK method or listener is replaced.
  plugins: [{
    name: "smoke-cache-observer",
    transform(code, id) {
      if (id.split("?")[0] === appPath) return `${code}
        window.clerkSmoke = {
          seed: () => queryClient.setQueryData(["clerk-smoke-private-cache"], "private"),
          hasMarker: () => queryClient.getQueryData(["clerk-smoke-private-cache"]) !== undefined,
          cachedAccessUsers: () => queryClient.getQueryCache().getAll()
            .filter(query => query.queryKey[0] === "/api/workspace/access")
            .map(query => String(query.queryKey[1])),
        };
      `;
      return null;
    },
  }, react(), tailwindcss()],
  define: {
    "import.meta.env.VITE_CLERK_PUBLISHABLE_KEY": JSON.stringify(publishableKey),
    "import.meta.env.VITE_CLERK_PROXY_URL": "undefined",
  },
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "../../src") },
    dedupe: ["react", "react-dom"],
  },
  server: {
    host: "127.0.0.1",
    port: 4180,
    strictPort: true,
    fs: { allow: [path.resolve(import.meta.dirname, "../../../..")] },
  },
});