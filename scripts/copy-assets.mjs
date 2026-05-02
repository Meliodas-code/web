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

fs.rmSync(destAssets, { recursive: true, force: true });
fs.cpSync(srcAssets, destAssets, { recursive: true });
console.log("[copy-assets] Copiado a web/public/assets");
