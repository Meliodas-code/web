import { rarityRank, normalizeRarity } from "./rarity.js";
import { VOTE_DISPLAY_ORDER, voteKey } from "./votes.js";

const STORAGE_KEY = "tdhub_value_history";
const MAX_SNAPSHOTS = 14;
const TRACKED_VOTES = [2, 13];

function voteVal(unit, vote_values, vk) {
  const base = Number(unit.valor) || 0;
  const uv = vote_values[unit.nombre] || {};
  if (vk === "voto13") return uv.voto13 ?? uv.voto2 ?? base;
  return uv[vk] ?? base;
}

function buildSnapshot(units, vote_values) {
  /** @type {Record<string, { valor: number, votes: Record<string, number> }>} */
  const map = {};
  for (const u of units) {
    const votes = {};
    for (const vn of VOTE_DISPLAY_ORDER) {
      const vk = voteKey(vn);
      votes[vk] = voteVal(u, vote_values, vk);
    }
    map[u.nombre] = { valor: Number(u.valor) || 0, votes };
  }
  return { at: Date.now(), units: map };
}

function loadHistory() {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const data = raw ? JSON.parse(raw) : [];
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveHistory(history) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history.slice(-MAX_SNAPSHOTS)));
  } catch {
    // ignore quota
  }
}

/** Guarda snapshot actual y devuelve historial actualizado. */
export function recordValueSnapshot(units, vote_values) {
  const history = loadHistory();
  const snap = buildSnapshot(units, vote_values);
  const last = history[history.length - 1];
  const same =
    last &&
    JSON.stringify(last.units) === JSON.stringify(snap.units);
  if (!same) {
    history.push(snap);
    saveHistory(history);
  }
  return history;
}

function trendFromDelta(delta, threshold = 0) {
  if (delta > threshold) return "up";
  if (delta < -threshold) return "down";
  return "stable";
}

function medianOf(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function rarityMedians(units) {
  /** @type {Record<string, number[]>} */
  const buckets = {};
  for (const u of units) {
    const r = normalizeRarity(u.rareza) || "other";
    if (!buckets[r]) buckets[r] = [];
    buckets[r].push(Number(u.valor) || 0);
  }
  /** @type {Record<string, number>} */
  const out = {};
  for (const [r, vals] of Object.entries(buckets)) {
    out[r] = medianOf(vals);
  }
  return out;
}

function sparklineFromHistory(history, unitName, field = "valor") {
  const points = [];
  for (const snap of history) {
    const row = snap.units?.[unitName];
    if (!row) continue;
    if (field === "valor") points.push(row.valor);
    else if (row.votes?.[field] != null) points.push(row.votes[field]);
  }
  if (points.length < 2) {
    const last = points[0] ?? 0;
    return [last, last];
  }
  return points;
}

/**
 * @returns {Array<{
 *   unit: object,
 *   base: { current: number, delta: number, trend: string, source: string },
 *   votes: Record<string, { current: number, delta: number, trend: string, source: string }>,
 *   sparkline: number[],
 *   score: number,
 *   tipKey: string
 * }>}
 */
export function buildPredictions(units, vote_values, history) {
  const prev = history.length >= 2 ? history[history.length - 2] : null;
  const medians = rarityMedians(units);
  const rows = [];

  for (const unit of units) {
    const name = unit.nombre;
    const curSnap = history[history.length - 1]?.units?.[name];
    const prevSnap = prev?.units?.[name];
    const current = Number(unit.valor) || 0;
    const prevVal = prevSnap?.valor ?? current;
    const delta = current - prevVal;
    let baseTrend = trendFromDelta(delta);
    let baseSource = prevSnap ? "change" : "none";

    if (baseTrend === "stable" && prevSnap) {
      const med = medians[normalizeRarity(unit.rareza)] ?? current;
      if (med > 0 && current < med * 0.88) {
        baseTrend = "forecast_up";
        baseSource = "heuristic";
      } else if (med > 0 && current > med * 1.12) {
        baseTrend = "forecast_down";
        baseSource = "heuristic";
      }
    } else if (!prevSnap) {
      baseSource = "heuristic";
      const med = medians[normalizeRarity(unit.rareza)] ?? current;
      if (med > 0 && current < med * 0.9) baseTrend = "forecast_up";
      else if (med > 0 && current > med * 1.1) baseTrend = "forecast_down";
    }

    /** @type {Record<string, { current: number, delta: number, trend: string, source: string }>} */
    const votes = {};
    for (const vn of TRACKED_VOTES) {
      const vk = voteKey(vn);
      const vCur = voteVal(unit, vote_values, vk);
      const vPrev = prevSnap?.votes?.[vk] ?? vCur;
      const vDelta = vCur - vPrev;
      let vTrend = trendFromDelta(vDelta);
      let vSource = prevSnap ? "change" : "none";
      if (vTrend === "stable" && baseTrend === "forecast_up") {
        vTrend = "forecast_up";
        vSource = "heuristic";
      } else if (vTrend === "stable" && baseTrend === "forecast_down") {
        vTrend = "forecast_down";
        vSource = "heuristic";
      }
      votes[vk] = { current: vCur, delta: vDelta, trend: vTrend, source: vSource };
    }

    const score =
      (baseTrend === "up" || baseTrend === "forecast_up" ? 2 : 0) +
      (baseTrend === "down" || baseTrend === "forecast_down" ? -2 : 0) +
      (votes.voto2?.trend === "up" ? 1 : votes.voto2?.trend === "down" ? -1 : 0);

    let tipKey = "predictions.tip_stable";
    if (baseTrend === "up" || votes.voto2?.trend === "up") tipKey = "predictions.tip_trade";
    else if (baseTrend === "forecast_up") tipKey = "predictions.tip_hold";
    else if (baseTrend === "down" || baseTrend === "forecast_down") tipKey = "predictions.tip_caution";

    rows.push({
      unit,
      base: {
        current,
        delta,
        trend: baseTrend,
        source: baseSource,
      },
      votes,
      sparkline: sparklineFromHistory(history, name, "valor"),
      score,
      tipKey,
    });
  }

  rows.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ra = rarityRank(a.unit.rareza);
    const rb = rarityRank(b.unit.rareza);
    if (ra !== rb) return rb - ra;
    return Math.abs(b.base.delta) - Math.abs(a.base.delta);
  });

  return rows;
}

export function predictionSummary(rows) {
  let up = 0;
  let down = 0;
  let stable = 0;
  for (const r of rows) {
    const t = r.base.trend;
    if (t === "up" || t === "forecast_up") up++;
    else if (t === "down" || t === "forecast_down") down++;
    else stable++;
  }
  return { up, down, stable, total: rows.length };
}

/** @typedef {"score"|"rarity"|"delta"|"value"|"name"} PredictionSortId */

/**
 * @param {ReturnType<typeof buildPredictions>} rows
 * @param {PredictionSortId} sortBy
 */
export function sortPredictionRows(rows, sortBy) {
  const copy = [...rows];
  if (sortBy === "rarity") {
    copy.sort((a, b) => {
      const ra = rarityRank(a.unit.rareza);
      const rb = rarityRank(b.unit.rareza);
      if (ra !== rb) return rb - ra;
      if (b.score !== a.score) return b.score - a.score;
      return Math.abs(b.base.delta) - Math.abs(a.base.delta);
    });
  } else if (sortBy === "delta") {
    copy.sort(
      (a, b) =>
        Math.abs(b.base.delta) - Math.abs(a.base.delta) ||
        b.score - a.score,
    );
  } else if (sortBy === "value") {
    copy.sort((a, b) => b.base.current - a.base.current || b.score - a.score);
  } else if (sortBy === "name") {
    copy.sort((a, b) =>
      a.unit.nombre.localeCompare(b.unit.nombre, "es", { sensitivity: "base" }),
    );
  }
  return copy;
}

/**
 * Tendencias agregadas por tier de rareza.
 * @param {ReturnType<typeof buildPredictions>} rows
 */
export function buildRarityBreakdown(rows) {
  /** @type {Record<string, { up: number, stable: number, down: number, total: number }>} */
  const out = {};
  for (const row of rows) {
    const r = normalizeRarity(row.unit.rareza) || "other";
    if (!out[r]) out[r] = { up: 0, stable: 0, down: 0, total: 0 };
    out[r].total++;
    const t = row.base.trend;
    if (t === "up" || t === "forecast_up") out[r].up++;
    else if (t === "down" || t === "forecast_down") out[r].down++;
    else out[r].stable++;
  }
  return out;
}

export function historySnapshotCount() {
  return loadHistory().length;
}
