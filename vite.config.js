import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const base = env.VITE_BASE_PATH || "/";
  return {
    base,
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
  };
});
