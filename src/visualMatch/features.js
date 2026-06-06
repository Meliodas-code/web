export const VECTOR_SIZE = 40;
export const MATCH_THRESHOLD = 0.7;
export const MATCH_GAP_MIN = 0.006;

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.loading = "eager";
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = String(src || "");
  });
}

export function vectorFromImage(img, size = VECTOR_SIZE, centerRatio = 1) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.clearRect(0, 0, size, size);
  const side = Math.min(img.naturalWidth || img.width, img.naturalHeight || img.height);
  const cr = Math.max(0.2, Math.min(1, centerRatio));
  const sx = ((img.naturalWidth || img.width) - side) / 2 + (side * (1 - cr)) / 2;
  const sy = ((img.naturalHeight || img.height) - side) / 2 + (side * (1 - cr)) / 2;
  const ss = side * cr;
  ctx.drawImage(img, sx, sy, ss, ss, 0, 0, size, size);
  return featureFromImageData(ctx.getImageData(0, 0, size, size).data, size, size);
}

export function vectorFromCrop(img, crop, centerRatio = 1) {
  const canvas = document.createElement("canvas");
  canvas.width = VECTOR_SIZE;
  canvas.height = VECTOR_SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  const c = Math.max(0.2, Math.min(1, centerRatio));
  const cx = crop.x + (crop.w * (1 - c)) / 2;
  const cy = crop.y + (crop.h * (1 - c)) / 2;
  const cw = crop.w * c;
  const ch = crop.h * c;
  ctx.drawImage(img, cx, cy, cw, ch, 0, 0, VECTOR_SIZE, VECTOR_SIZE);
  return featureFromImageData(
    ctx.getImageData(0, 0, VECTOR_SIZE, VECTOR_SIZE).data,
    VECTOR_SIZE,
    VECTOR_SIZE,
  );
}

function featureFromImageData(raw, width, height) {
  const gray = new Float32Array(width * height);
  const bins = new Uint32Array(64);
  const rgb = new Float32Array(width * height * 3);
  for (let i = 0, p = 0; i < raw.length; i += 4, p += 1) {
    const r = raw[i];
    const g = raw[i + 1];
    const b = raw[i + 2];
    const a = raw[i + 3] / 255;
    rgb[p * 3] = r / 255;
    rgb[p * 3 + 1] = g / 255;
    rgb[p * 3 + 2] = b / 255;
    bins[((r >> 6) << 4) | ((g >> 6) << 2) | (b >> 6)] += 1;
    gray[p] = ((0.299 * r + 0.587 * g + 0.114 * b) / 255) * a;
  }
  let maxBin = 0;
  for (let i = 1; i < bins.length; i++) {
    if (bins[i] > bins[maxBin]) maxBin = i;
  }
  const bgR = ((maxBin >> 4) & 0b11) / 3;
  const bgG = ((maxBin >> 2) & 0b11) / 3;
  const bgB = (maxBin & 0b11) / 3;
  const feat = new Float32Array(width * height);
  const occ = new Float32Array(64);
  const hist = new Float32Array(12);
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const rx = Math.max(1, cx);
  const ry = Math.max(1, cy);
  let fgCount = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const p = y * width + x;
      const gx = gray[p + 1] - gray[p - 1];
      const gy = gray[p + width] - gray[p - width];
      let mag = Math.hypot(gx, gy);
      const pr = rgb[p * 3];
      const pg = rgb[p * 3 + 1];
      const pb = rgb[p * 3 + 2];
      const bgDist = Math.hypot(pr - bgR, pg - bgG, pb - bgB);
      const fgWeight = Math.max(0, Math.min(1, (bgDist - 0.08) / 0.34));
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      const radial = Math.max(0, 1 - Math.hypot(dx, dy));
      mag *= (0.24 + radial * 0.76) * (0.28 + fgWeight * 0.72);
      if (x > width * 0.72 && y > height * 0.72) mag *= 0.3;
      if (x < width * 0.2 && y < height * 0.2) mag *= 0.55;
      feat[p] = mag;
      if (fgWeight > 0.24) {
        fgCount += 1;
        const gx8 = Math.min(7, Math.floor((x / width) * 8));
        const gy8 = Math.min(7, Math.floor((y / height) * 8));
        occ[gy8 * 8 + gx8] += 1;
        const hueBin = Math.min(5, Math.floor(pr * 6));
        const sat = Math.max(pr, pg, pb) - Math.min(pr, pg, pb);
        hist[(sat > 0.28 ? 1 : 0) * 6 + hueBin] += 1;
      }
    }
  }
  let mean = 0;
  for (let i = 0; i < feat.length; i++) mean += feat[i];
  mean /= feat.length || 1;
  let sq = 0;
  for (let i = 0; i < feat.length; i++) {
    const d = feat[i] - mean;
    sq += d * d;
  }
  const std = Math.sqrt(sq / (feat.length || 1)) || 1;
  for (let i = 0; i < feat.length; i++) feat[i] = (feat[i] - mean) / std;
  const occNorm = Math.max(1, fgCount);
  for (let i = 0; i < occ.length; i++) occ[i] /= occNorm;
  const histNorm = hist.reduce((a, b) => a + b, 0) || 1;
  for (let i = 0; i < hist.length; i++) hist[i] /= histNorm;
  return { edge: feat, occ, hist };
}

export function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    na += vecA[i] * vecA[i];
    nb += vecB[i] * vecB[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (!denom) return 0;
  return (dot / denom + 1) / 2;
}

export function histogramSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let num = 0;
  let den = 0;
  for (let i = 0; i < a.length; i++) {
    num += Math.min(a[i], b[i]);
    den += Math.max(a[i], b[i]);
  }
  return den > 0 ? num / den : 0;
}

export function compareFeatureSets(srcFull, srcCenter, tpl) {
  const simFullEdge = cosineSimilarity(srcFull.edge, tpl.full.edge);
  const simCenterEdge = cosineSimilarity(srcCenter.edge, tpl.center.edge);
  const simOcc =
    (cosineSimilarity(srcFull.occ, tpl.full.occ) +
      cosineSimilarity(srcCenter.occ, tpl.center.occ)) /
    2;
  const simHist =
    (histogramSimilarity(srcFull.hist, tpl.full.hist) +
      histogramSimilarity(srcCenter.hist, tpl.center.hist)) /
    2;
  return simFullEdge * 0.25 + simCenterEdge * 0.45 + simOcc * 0.2 + simHist * 0.1;
}

/** Mapea similitud interna (0–1) a porcentaje legible tipo 96.4% */
export function similarityToConfidence(similarity) {
  const t = Math.max(0, Math.min(1, similarity));
  const boosted = 1 - Math.pow(1 - t, 1.35);
  return Math.round(boosted * 1000) / 10;
}
