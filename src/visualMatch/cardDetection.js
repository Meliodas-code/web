import { loadImage } from "./features.js";

function iou(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const iw = Math.max(0, x2 - x1);
  const ih = Math.max(0, y2 - y1);
  const inter = iw * ih;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

function blueColumnCrops(img) {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const canvas = document.createElement("canvas");
  const dw = Math.min(420, w);
  const dh = Math.max(1, Math.round((h / w) * dw));
  canvas.width = dw;
  canvas.height = dh;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return [{ x: 0, y: 0, w, h }];
  ctx.drawImage(img, 0, 0, dw, dh);
  const data = ctx.getImageData(0, 0, dw, dh).data;
  const colScore = new Float32Array(dw);
  for (let x = 0; x < dw; x++) {
    let blueHits = 0;
    for (let y = 0; y < dh; y += 2) {
      const p = (y * dw + x) * 4;
      const r = data[p];
      const g = data[p + 1];
      const b = data[p + 2];
      if (b > 120 && b - Math.max(r, g) > 55) blueHits++;
    }
    colScore[x] = blueHits / Math.max(1, Math.ceil(dh / 2));
  }
  let mean = 0;
  for (let x = 0; x < dw; x++) mean += colScore[x];
  mean /= dw || 1;
  const thr = Math.min(0.55, Math.max(0.18, mean * 1.35));
  const runs = [];
  let x = 0;
  while (x < dw) {
    while (x < dw && colScore[x] < thr) x++;
    if (x >= dw) break;
    const x0 = x;
    while (x < dw && colScore[x] >= thr) x++;
    const x1 = x - 1;
    if (x1 - x0 + 1 >= Math.floor(dw * 0.12)) {
      runs.push({ x0, x1 });
    }
  }
  if (!runs.length) return [{ x: 0, y: 0, w, h }];
  const scale = w / dw;
  return runs.map(({ x0, x1 }) => {
    const cx = Math.round(x0 * scale);
    const cw = Math.max(1, Math.round((x1 - x0 + 1) * scale));
    return { x: cx, y: 0, w: Math.min(cw, w - cx), h };
  });
}

function gridCrops(img, cols, rows) {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const crops = [];
  const cellW = w / cols;
  const cellH = h / rows;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      crops.push({
        x: Math.round(col * cellW),
        y: Math.round(row * cellH),
        w: Math.round(cellW),
        h: Math.round(cellH),
      });
    }
  }
  return crops;
}

export function buildCardCrops(img) {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const aspect = w / Math.max(1, h);
  const fromBlue = blueColumnCrops(img);
  const candidates = [...fromBlue];

  if (aspect > 1.35) {
    candidates.push(...gridCrops(img, Math.min(6, fromBlue.length || 3), 1));
  }
  if (aspect > 0.85 && aspect < 1.35) {
    candidates.push(...gridCrops(img, 2, 2));
    candidates.push(...gridCrops(img, 3, 2));
  }

  candidates.push({ x: 0, y: 0, w, h });

  const deduped = [];
  for (const c of candidates) {
    if (c.w < 24 || c.h < 24) continue;
    let overlaps = false;
    for (const d of deduped) {
      if (iou(c, d) > 0.72) {
        overlaps = true;
        break;
      }
    }
    if (!overlaps) deduped.push(c);
  }
  return deduped.slice(0, 16);
}

export async function estimateCardCount(dataUrl) {
  try {
    const img = await loadImage(dataUrl);
    return Math.max(1, Math.min(12, buildCardCrops(img).length));
  } catch {
    return 1;
  }
}
