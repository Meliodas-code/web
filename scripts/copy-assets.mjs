import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..", "..");
const srcAssets = path.join(repoRoot, "assets");
const destAssets = path.join(__dirname, "..", "public", "assets");

const publicRoot = path.join(__dirname, "..", "public");
fs.mkdirSync(publicRoot, { recursive: true });

if (!fs.existsSync(srcAssets)) {
  console.warn(
    "[copy-assets] No se encontró la carpeta assets junto al proyecto. Las imágenes no se copiarán."
  );
  process.exit(0);
}

function copyMerge(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyMerge(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

copyMerge(srcAssets, destAssets);
console.log("[copy-assets] Copiado a web/public/assets (merge, sin borrar extras)");
