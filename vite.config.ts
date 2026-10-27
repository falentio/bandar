import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";
import { DEFAULT_API_PORT, DEFAULT_WEB_PORT, loopbackOrigin } from "./src/shared/topology";

const ignored = [
  "src/server/generated/**",
  "dist/**",
  ".build/**",
  "drizzle/**",
  "tools/oxlint/anti-slop/**",
];

const apiPort = Number(process.env.BANDAR_PORT ?? DEFAULT_API_PORT);

// Vendored from https://github.com/dmmulroy/anti-slop. Rules are local policy; edit them here.
const antiSlopRules = {
  "oxc/no-accumulating-spread": "error",
  "anti-slop/no-array-filter-map": "error",
  "anti-slop/no-reduce-accumulator-copy": "error",
  "anti-slop/no-chained-type-assertions": "error",
  "anti-slop/no-conditional-empty-object-spread": "error",
  "anti-slop/no-known-value-widening": "error",
  "anti-slop/no-module-mocking": "error",
  "anti-slop/no-object-parameters": "error",
  "anti-slop/no-reflect-apply": "error",
  "anti-slop/no-reflect-get": "error",
  "anti-slop/no-runtime-typeof": "error",
  "anti-slop/no-shape-in-symbol-names": "error",
  "anti-slop/no-unknown-parameters": "error",
  "anti-slop/no-unknown-returns": "error",
  "anti-slop/no-unknown-type-aliases": "error",
  "anti-slop/no-unsafe-dictionary-type": "error",
  "anti-slop/no-widen-then-assert": "error",
  "anti-slop/require-readable-spacing": "error",
  "anti-slop/require-safety-comment-for-type-assertion": "error",
} as const;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
  server: {
    host: true,
    port: DEFAULT_WEB_PORT,
    // MagicDNS names resolve to this machine on the tailnet; Vite rejects unknown Host headers.
    allowedHosts: [".ts.net"],
    proxy: {
      "/api": { target: loopbackOrigin(apiPort), changeOrigin: true },
    },
  },
  fmt: { ignorePatterns: ignored },
  lint: {
    ignorePatterns: ignored,
    jsPlugins: [{ name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" }],
    rules: antiSlopRules,
    options: { typeAware: true, typeCheck: true },
  },
});
