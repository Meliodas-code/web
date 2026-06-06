import { loadImage, vectorFromImage, VECTOR_SIZE } from "./features.js";

const templateCache = new Map();
const voteTemplateCache = new Map();

export function clearTemplateCache() {
  templateCache.clear();
  voteTemplateCache.clear();
}

export async function templateForUnit(unit, resolveAssetUrl) {
  if (!unit?.imagen) return null;
  if (templateCache.has(unit.nombre)) return templateCache.get(unit.nombre);
  try {
    const img = await loadImage(resolveAssetUrl(unit.imagen));
    const packed = {
      full: vectorFromImage(img),
      center: vectorFromImage(img, VECTOR_SIZE, 0.7),
    };
    templateCache.set(unit.nombre, packed);
    return packed;
  } catch {
    templateCache.set(unit.nombre, null);
    return null;
  }
}

export async function warmUnitTemplates(unitList, resolveAssetUrl) {
  await Promise.all(
    unitList.map((unit) => templateForUnit(unit, resolveAssetUrl)),
  );
}

export async function voteTemplates(resolveAssetUrl) {
  if (voteTemplateCache.size) return voteTemplateCache;
  for (let i = 1; i <= 13; i++) {
    try {
      const img = await loadImage(resolveAssetUrl(`assets/votos/voto${i}.png`));
      const v = vectorFromImage(img, 32, 1);
      if (v) voteTemplateCache.set(i, v);
    } catch {
      // asset opcional
    }
  }
  return voteTemplateCache;
}
