const ALIAS = {
  epico: "epic",
  épico: "epic",
  legendario: "legendary",
  mitico: "mythic",
  mítico: "mythic",
  mithyco: "mythic",
  mythico: "mythic",
  "grado especial": "special grade",
  special: "special grade",
  "grado ascendido": "ascended grade",
  ascended: "ascended grade",
  aniversary: "aniversary",
  anniversary: "aniversary",
  aniversario: "aniversary",
};

const ORDER = {
  epic: 0,
  legendary: 1,
  mythic: 2,
  "special grade": 3,
  "ascended grade": 4,
  aniversary: 5,
};

export function normalizeRarity(raw) {
  const s = String(raw || "")
    .trim()
    .toLowerCase();
  return ALIAS[s] ?? s;
}

export function rarityRank(rarity) {
  const n = normalizeRarity(rarity);
  return ORDER[n] ?? 99;
}

const LABELS = {
  es: {
    epic: "Épico",
    legendary: "Legendario",
    mythic: "Mítico",
    "special grade": "Grado Especial",
    "ascended grade": "Grado Ascendido",
    aniversary: "Aniversario",
  },
  en: {
    epic: "Epic",
    legendary: "Legendary",
    mythic: "Mythic",
    "special grade": "Special Grade",
    "ascended grade": "Ascended Grade",
    aniversary: "Anniversary",
  },
};

/** @param {"es"|"en"} lang */
export function rarityLabel(lang, raw) {
  const n = normalizeRarity(raw);
  const table = LABELS[lang] ?? LABELS.es;
  return table[n] || String(raw || "").trim() || "—";
}

/** Orden de mayor a menor rareza (para filtros UI). */
export const RARITY_IDS_DESC = [
  "aniversary",
  "ascended grade",
  "special grade",
  "mythic",
  "legendary",
  "epic",
];
