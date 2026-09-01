import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineConfig } from "vite";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(projectRoot, "github-pages"),
  base: "/ohaus-tolerance-assistant/",
  publicDir: path.join(projectRoot, "public"),
  plugins: [react()],
  resolve: {
    alias: {
      "@": projectRoot,
    },
  },
  build: {
    outDir: path.join(projectRoot, "pages-dist"),
    emptyOutDir: true,
  },
});
