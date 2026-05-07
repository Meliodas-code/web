import { defineConfig } from "vite";

export default defineConfig({
  // Esto arregla los errores 404 de JS y CSS
  base: "/web/", 
  root: ".",
  publicDir: "public",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // AÑADIMOS ESTO PARA QUE GITHUB PAGES NO DE ERROR AL COMPILAR
    rollupOptions: {
      external: ["@google/generative-ai"],
    },
  },
});