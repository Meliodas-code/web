import { t } from "./strings.js";

/** Orden de columnas en tablas: Caster 2 justo después de Caster 1. */
export const VOTE_DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 7, 8, 9, 13, 10, 11, 12];

export function voteKey(num) {
  return `voto${num}`;
}

/** @param {"es"|"en"} lang */
export function voteDisplayLabel(lang, num) {
  return t(lang, `votes.v${num}`);
}
