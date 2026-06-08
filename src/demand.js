/** @typedef {"stable"|"dropping"|"fluctuating"} StabilityId */
/** @typedef {"fair"|"overpay"|"underpay"|"unknown"} DemandStatusId */

const STABILITY_ALIASES = {
  stable: "stable",
  estable: "stable",
  dropping: "dropping",
  bajando: "dropping",
  drop: "dropping",
  fluctuating: "fluctuating",
  fluctuando: "fluctuating",
  fluctuate: "fluctuating",
};

/** Margen estimado por punto de demanda sobre el neutro (5/10), en %. */
const MARGIN_PER_POINT = 4;
const FAIR_THRESHOLD_PCT = 2;

/**
 * @param {unknown} raw
 * @returns {number | null}
 */
export function parseDemanda(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string" && raw.trim() === "") return null;
  const m = String(raw).match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(10, n));
}

/**
 * @param {unknown} raw
 * @returns {StabilityId}
 */
export function normalizeStability(raw) {
  const key = String(raw || "")
    .trim()
    .toLowerCase()
    .normalize("NFC");
  return STABILITY_ALIASES[key] || "fluctuating";
}

/**
 * @param {number | null | undefined} demanda
 * @param {number} baseValor
 * @returns {{
 *   status: DemandStatusId,
 *   demanda: number | null,
 *   marginPct: number,
 *   marginAbs: number,
 *   estimatedValue: number | null,
 * }}
 */
export function computeDemandValuation(demanda, baseValor) {
  const base = Number(baseValor) || 0;
  const d = parseDemanda(demanda);
  if (d === null || base <= 0) {
    return {
      status: "unknown",
      demanda: null,
      marginPct: 0,
      marginAbs: 0,
      estimatedValue: null,
    };
  }

  const marginPct = (d - 5) * MARGIN_PER_POINT;
  const estimatedValue = Math.max(0, Math.round(base * (1 + marginPct / 100)));
  const marginAbs = estimatedValue - base;

  let status = "fair";
  if (marginPct > FAIR_THRESHOLD_PCT) status = "overpay";
  else if (marginPct < -FAIR_THRESHOLD_PCT) status = "underpay";

  return { status, demanda: d, marginPct, marginAbs, estimatedValue };
}

/**
 * @param {"es"|"en"} lang
 * @param {StabilityId} stability
 * @param {(lang: "es"|"en", key: string) => string} t
 */
export function stabilityLabel(lang, stability, t) {
  return t(lang, `demand.stability_${stability}`);
}
