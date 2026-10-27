import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";
import { DEFAULT_API_PORT, DEFAULT_WEB_PORT, loopbackOrigin } from "./src/shared/topology";

const ignored = ["src/server/generated/**", "dist/**", ".build/**", "drizzle/**"];
const apiPort = Number(process.env.BANDAR_PORT ?? DEFAULT_API_PORT);

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
    port: DEFAULT_WEB_PORT,
    proxy: {
      "/api": { target: loopbackOrigin(apiPort), changeOrigin: true },
    },
  },
  fmt: { ignorePatterns: ignored },
  lint: {
    ignorePatterns: ignored,
    options: { typeAware: true, typeCheck: true },
  },
});
