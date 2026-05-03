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
};

const ORDER = {
  epic: 0,
  legendary: 1,
  mythic: 2,
  "special grade": 3,
  "ascended grade": 4,
  "Aniversary": 5,
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
