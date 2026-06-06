import {
  compareFeatureSets,
  cosineSimilarity,
  histogramSimilarity,
  loadImage,
  MATCH_GAP_MIN,
  MATCH_THRESHOLD,
  similarityToConfidence,
  vectorFromCrop,
} from "./features.js";
import { buildCardCrops } from "./cardDetection.js";
import { templateForUnit, voteTemplates } from "./templates.js";

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

async function rankCropAgainstUnits(img, crop, unitList, resolveAssetUrl) {
  const srcFull = vectorFromCrop(img, crop, 1);
  const srcCenter = vectorFromCrop(img, crop, 0.7);
  if (!srcFull || !srcCenter) return [];

  const rows = [];
  for (const unit of unitList) {
    const tpl = await templateForUnit(unit, resolveAssetUrl);
    if (!tpl?.full || !tpl?.center) continue;
    const similarity = compareFeatureSets(srcFull, srcCenter, tpl);
    rows.push({ unit, similarity });
  }
  rows.sort((a, b) => b.similarity - a.similarity);
  return rows;
}

async function detectVoteFromCrop(img, cropRect, resolveAssetUrl) {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const x = Math.max(0, cropRect.x);
  const y = Math.max(0, cropRect.y);
  const cw = Math.max(1, cropRect.w);
  const ch = Math.max(1, cropRect.h);
  const corner = Math.floor(Math.min(cw, ch) * 0.38);
  const corners = [
    { x, y: y + ch - corner, w: corner, h: corner },
    { x: x + cw - corner, y: y + ch - corner, w: corner, h: corner },
  ];
  const tpl = await voteTemplates(resolveAssetUrl);
  let best = { vote: 1, sim: 0 };
  for (const c of corners) {
    const vec = vectorFromCrop(img, c, 1);
    if (!vec) continue;
    for (const [vote, tvec] of tpl.entries()) {
      const sim =
        cosineSimilarity(vec.edge, tvec.edge) * 0.55 +
        cosineSimilarity(vec.occ, tvec.occ) * 0.25 +
        histogramSimilarity(vec.hist, tvec.hist) * 0.2;
      if (sim > best.sim) best = { vote, sim };
    }
  }
  return best.sim >= 0.62 ? best.vote : 1;
}

function withConfidence(rows, topN) {
  return rows.slice(0, topN).map((row, index) => ({
    ...row,
    rank: index + 1,
    confidencePercent: similarityToConfidence(row.similarity),
  }));
}

async function detectUnitsInImage(img, unitList, resolveAssetUrl) {
  const crops = buildCardCrops(img);
  const rawHits = [];
  let bestGlobal = null;

  for (const crop of crops) {
    const ranked = await rankCropAgainstUnits(img, crop, unitList, resolveAssetUrl);
    const best = ranked[0];
    const second = ranked[1];
    if (!best) continue;
    if (!bestGlobal || best.similarity > bestGlobal.similarity) {
      bestGlobal = { ...best, rect: crop };
    }
    const gap = best.similarity - (second?.similarity ?? 0);
    if (best.similarity < MATCH_THRESHOLD || gap < MATCH_GAP_MIN) continue;
    rawHits.push({ ...best, rect: crop });
  }

  rawHits.sort((a, b) => b.similarity - a.similarity);
  const selected = [];
  for (const h of rawHits) {
    let overlaps = false;
    for (const s of selected) {
      if (iou(h.rect, s.rect) > 0.42) {
        overlaps = true;
        break;
      }
    }
    if (!overlaps) selected.push(h);
    if (selected.length >= 12) break;
  }

  const merged = new Map();
  for (const h of selected) {
    const prev = merged.get(h.unit.nombre) || {
      unit: h.unit,
      count: 0,
      bestSimilarity: 0,
    };
    prev.count += 1;
    prev.bestSimilarity = Math.max(prev.bestSimilarity, h.similarity);
    merged.set(h.unit.nombre, prev);
  }

  const detections = [];
  for (const row of merged.values()) {
    const bestRect = selected
      .filter((s) => s.unit?.nombre === row.unit?.nombre)
      .sort((a, b) => b.similarity - a.similarity)[0]?.rect;
    const vote = bestRect
      ? await detectVoteFromCrop(img, bestRect, resolveAssetUrl)
      : 1;
    detections.push({
      unit: row.unit,
      count: row.count,
      bestSimilarity: row.bestSimilarity,
      confidencePercent: similarityToConfidence(row.bestSimilarity),
      vote,
    });
  }

  detections.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return b.bestSimilarity - a.bestSimilarity;
  });

  if (detections.length) return detections;

  if (bestGlobal && bestGlobal.similarity >= 0.58) {
    const vote = await detectVoteFromCrop(img, bestGlobal.rect, resolveAssetUrl);
    return [
      {
        unit: bestGlobal.unit,
        count: 1,
        bestSimilarity: bestGlobal.similarity,
        confidencePercent: similarityToConfidence(bestGlobal.similarity),
        vote,
      },
    ];
  }

  return [];
}

/**
 * Compara una imagen subida contra las imágenes oficiales de cada unidad.
 *
 * @param {string} imageSource - Data URL o URL de imagen
 * @param {Array<{nombre:string, imagen:string, valor:number, rareza:string}>} unitList
 * @param {{ topN?: number, resolveAssetUrl?: (p:string)=>string }} [options]
 * @returns {Promise<{
 *   rankings: Array<{ unit, similarity }>,
 *   top5: Array<{ unit, similarity, rank, confidencePercent }>,
 *   detections: Array<{ unit, count, vote, bestSimilarity, confidencePercent }>
 * }>}
 */
export async function compareImageWithUnits(imageSource, unitList, options = {}) {
  const topN = Math.max(1, options.topN ?? 5);
  const resolveAssetUrl =
    typeof options.resolveAssetUrl === "function"
      ? options.resolveAssetUrl
      : (p) => p;

  const img = await loadImage(imageSource);
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const fullCrop = { x: 0, y: 0, w, h };

  const rankings = await rankCropAgainstUnits(img, fullCrop, unitList, resolveAssetUrl);
  const top5 = withConfidence(rankings, topN);
  const detections = await detectUnitsInImage(img, unitList, resolveAssetUrl);

  return { rankings, top5, detections };
}
