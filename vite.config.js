import { defineConfig } from "vite";

export default defineConfig({
  // Esto arregla los errores 404
  base: "/web/", 
  root: ".",
  publicDir: "public",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});