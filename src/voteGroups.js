import { VOTE_DISPLAY_ORDER, ESSENTIAL_VOTE_NUMS, voteKey } from "./votes.js";

export function voteValueFor(unit, vote_values, vk) {
  const base = Number(unit.valor) || 0;
  const uv = vote_values[unit.nombre] || {};
  if (vk === "voto13") return uv.voto13 ?? uv.voto2 ?? base;
  return uv[vk] ?? base;
}

/**
 * Agrupa votos por valor único (incompatibles = mismo valor, varios votos).
 * @param {{ nombre: string, valor: number }} unit
 * @param {Record<string, Record<string, number>>} vote_values
 */
export function uniqueVoteGroupsForUnit(unit, vote_values) {
  const baseVal = Number(unit.valor) || 0;
  const applicable = VOTE_DISPLAY_ORDER.filter((vn) => {
    if (ESSENTIAL_VOTE_NUMS.includes(vn)) return true;
    return voteValueFor(unit, vote_values, voteKey(vn)) !== baseVal;
  });

  /** @type {Map<number, number[]>} */
  const byValue = new Map();
  for (const vn of applicable) {
    const v = voteValueFor(unit, vote_values, voteKey(vn));
    if (!byValue.has(v)) byValue.set(v, []);
    byValue.get(v).push(vn);
  }

  const seen = new Set();
  /** @type {Array<{ value: number, voteNums: number[], bucketKey: string, isIncompatible: boolean }>} */
  const out = [];
  for (const vn of applicable) {
    const v = voteValueFor(unit, vote_values, voteKey(vn));
    if (seen.has(v)) continue;
    seen.add(v);
    const voteNums = byValue.get(v) || [vn];
    out.push({
      value: v,
      voteNums,
      bucketKey: `val:${v}`,
      isIncompatible: voteNums.length > 1,
    });
  }
  return out;
}
