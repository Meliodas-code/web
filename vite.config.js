import { defineConfig } from "vite";

export default defineConfig({
  // Forzamos la ruta al nombre de tu repo
  base: "/web/", 
  root: ".",
  publicDir: "public",
  server: {
    port: 5173,
    open: true,
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    emptyOutDir: true,
  },
});