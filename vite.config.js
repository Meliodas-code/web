import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // ESTA LÍNEA ES LA QUE QUITA EL ERROR 404
  base: "/web/", 
  plugins: [react()],
  build: {
    outDir: "dist",
  },
});