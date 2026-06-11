import { assetUrl } from "./assetUrl.js";
import { loadUnitsAndVotes } from "./supabase/loadData.js";
import {
  rarityRank,
  normalizeRarity,
  rarityLabel,
  RARITY_IDS_DESC,
} from "./rarity.js";
import { t } from "./strings.js";
import {
  VOTE_DISPLAY_ORDER,
  ESSENTIAL_VOTE_NUMS,
  voteKey,
  voteDisplayLabel,
} from "./votes.js";
import { callEdgeFunction, edgeFunctionsConfigured } from "./edgeApi.js";
import {
  compareImageWithUnits,
  warmUnitTemplates,
} from "./visualMatch/index.js";
import {
  recordValueSnapshot,
  buildPredictions,
  predictionSummary,
  historySnapshotCount,
  sortPredictionRows,
  buildRarityBreakdown,
} from "./predictions.js";
import {
  stabilityLabel,
  demandScoreTier,
  effectiveTradeValue,
} from "./demand.js";

/** Lista de valores oficial (Sorcerer TD Value list). */
const OFFICIAL_VALUE_LIST_URL =
  "https://docs.google.com/spreadsheets/d/1--hVDdfHVSGLI1MF_Cmo0Te1Ir71KUxqnaqRX_CRCyI/htmlview?gid=0&pru=AAABnNPEMFQ*iMq033usqNrkyrEjGY0jeQ#gid=0";

/** @typedef {{nombre:string,nombre_en:string,valor:number,imagen:string,rareza:string,demanda:number|null,estabilidad:import("./demand.js").StabilityId}} Unit */

/** @type {Unit[]} */
let units = [];
/** @type {Record<string, Record<string, number>>} */
let vote_values = {};
/** @type {Array<{at:number, units:Record<string, {valor:number, votes:Record<string, number>}>}>} */
let valueHistory = [];
let predictionsFilter =
  typeof localStorage !== "undefined"
    ? localStorage.getItem("tdhub_pred_filter") || "all"
    : "all";

/** @type {"score"|"rarity"|"delta"|"value"|"name"} */
let predictionsSort =
  typeof localStorage !== "undefined"
    ? localStorage.getItem("tdhub_pred_sort") || "value"
    : "value";

/** @type {"all" | string} */
let predictionsRarityFilter =
  typeof localStorage !== "undefined"
    ? readRarityFilter("tdhub_pred_rarity")
    : "all";

const LANG_COOKIE = "tdhub_lang";
const LANG_COOKIE_MAX_AGE = 365 * 24 * 60 * 60;

function getCookie(name) {
  if (typeof document === "undefined") return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = document.cookie.match(new RegExp(`(?:^|; )${escaped}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
}

function setCookie(name, value, maxAge = LANG_COOKIE_MAX_AGE) {
  if (typeof document === "undefined") return;
  const secure =
    typeof location !== "undefined" && location.protocol === "https:"
      ? "; Secure"
      : "";
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAge}; SameSite=Lax${secure}`;
}

/** @returns {"es"|"en"} */
function loadSavedLang() {
  const fromCookie = getCookie(LANG_COOKIE);
  if (fromCookie === "en" || fromCookie === "es") return fromCookie;
  if (typeof localStorage !== "undefined") {
    const legacy = localStorage.getItem(LANG_COOKIE);
    if (legacy === "en" || legacy === "es") {
      setCookie(LANG_COOKIE, legacy);
      return legacy;
    }
  }
  return "es";
}

let lang = loadSavedLang();

const calcSelections = Object.create(null);
const calcLastVote = Object.create(null);

const tradeLeftCounts = Object.create(null);
const tradeRightCounts = Object.create(null);
const tradeLeftLast = Object.create(null);
const tradeRightLast = Object.create(null);
let lastTradeBarFlex = { left: 1, right: 1 };

/** @type {HTMLDialogElement | null} */
let voteDialogEl = null;
/** @type {{mode:'calc'|'trade', unitName:string, side:string, unit:Unit|null}} */
let modalCtx = { mode: "calc", unitName: "", side: "left", unit: null };

/** @type {string} última búsqueda calculadora / trade / values */
let lastSearchCalc = "";
let lastSearchTrade = "";
let lastSearchValues = "";

function readRarityFilter(storageKey) {
  const saved = localStorage.getItem(storageKey) || "all";
  return saved === "all" || RARITY_IDS_DESC.includes(saved) ? saved : "all";
}

/** @type {"all" | string} */
let calcRarityFilter =
  typeof localStorage !== "undefined"
    ? readRarityFilter("tdhub_calc_rarity")
    : "all";

const OWNED_UNITS_STORAGE = "tdhub_owned_units";
const TRADE_SUGGEST_OPEN_KEY = "tdhub_trade_suggest_open";

function readTradeSuggestionsOpen() {
  if (typeof localStorage === "undefined") return false;
  const saved = localStorage.getItem(TRADE_SUGGEST_OPEN_KEY);
  if (saved === "1") return true;
  if (saved === "0") return false;
  try {
    const raw = localStorage.getItem(OWNED_UNITS_STORAGE);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) && arr.length > 0;
  } catch {
    return false;
  }
}

/** @type {"all" | string} */
let tradeSuggestionsOpen = readTradeSuggestionsOpen();
/** @typedef {{ id: string, nombre: string, voteKey: string, qty: number }} OwnedInventoryEntry */
/** @type {OwnedInventoryEntry[]} */
let tradeOwnedInventory = loadOwnedInventory();
/** @type {HTMLDialogElement | null} */
let tradeInventoryDialogEl = null;
/** @type {string} */
let tradeInventorySelectedUnit = "";
let tradeRarityFilter =
  typeof localStorage !== "undefined"
    ? readRarityFilter("tdhub_trade_rarity")
    : "all";

/** @type {"all" | string} */
let valuesRarityFilter =
  typeof localStorage !== "undefined"
    ? readRarityFilter("tdhub_values_rarity")
    : "all";

/** Tras escribir en el buscador, re-render quita foco — lo restauramos solo en ese caso. */
let pendingToolbarFocusRoute =
  /** @type {null | "calc" | "trade" | "values"} */ (null);

/** Cuenta atrás pantalla Scanner (se limpia al cambiar de ruta). */
let scannerCountdownTimer = /** @type {ReturnType<typeof setInterval> | null} */ (null);

/** Friday May 29, 2026, 20:00 PM (Spain mainland). */
const SCANNER_LAUNCH_AT_MS = Date.parse("2026-05-15T20:00:00+02:00"); 

const TD_MOBILE_MQ =
  typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(max-width: 640px)")
    : null;

let testerIpStatus = /** @type {"pending" | "allowed" | "denied"} */ ("pending");
let appBootstrapped = false;
let hasPlayedEnterAnim = false;
let hasPlayedPageIntro = false;
const CREDITS_PROFILES = [
  {
    roleKey: "credits.role_creator",
    handle: "@meliodas_000",
    initials: "ME",
    accent: "meli",
    avatar: "assets/meliodas.jpg",
    discordUrl: "https://discord.com/app",
    robloxUrl: "https://www.roblox.com/es/users/3957024867/profile",
  },
  {
    roleKey: "credits.role_idea_db",
    handle: "@Toropapita",
    initials: "TO",
    accent: "toro",
    avatar: "assets/toropapita.jpg",
    discordUrl: "https://discord.com/app",
    robloxUrl: "https://www.roblox.com/es/users/1202005376/profile",
  },
  {
    roleKey: "credits.role_tester_ideas",
    handle: "@acexx01",
    initials: "AC",
    accent: "acex",
    avatar: "assets/acexx01.jpg",
    discordUrl: "https://discord.com/app",
    robloxUrl: "https://www.roblox.com/",
  },
];

let scannerTesterError = "";
let scannerTesterNotice = "";
let scannerTesterImageDataUrl = "";
let scannerTesterAnalyzing = false;
let scannerTesterMatches = [];
let scannerTesterTop5 = [];
const CORRECTION_HISTORY_KEY = "td_correction_history";
const routeScrollTop = Object.create(null);
const tradePickerScrollTop = { left: 0, right: 0 };

function loadCorrectionHistory() {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(CORRECTION_HISTORY_KEY);
    const data = raw ? JSON.parse(raw) : [];
    return Array.isArray(data) ? data.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function saveCorrection(incorrect, correct) {
  if (!incorrect || !correct) return;
  const entry = `Si ves [${incorrect}], en realidad es [${correct}]`;
  const history = loadCorrectionHistory();
  if (history.includes(entry)) return history;
  history.push(entry);
  try {
    localStorage.setItem(CORRECTION_HISTORY_KEY, JSON.stringify(history));
  } catch (err) {
    console.warn("No se pudo guardar la corrección:", err);
  }
  return history;
}

function buildCorrectionHistoryBlock() {
  const history = loadCorrectionHistory();
  if (!history.length) return "";
  return ["HISTORIAL DE LECCIONES DEL USUARIO:", ...history].join("\n") + "\n\n";
}

function syncTdMobileAttr() {
  document.documentElement.dataset.tdMobile =
    TD_MOBILE_MQ?.matches ? "1" : "0";
}

if (TD_MOBILE_MQ) {
  TD_MOBILE_MQ.addEventListener("change", syncTdMobileAttr);
}

function clearScannerCountdown() {
  if (scannerCountdownTimer) {
    clearInterval(scannerCountdownTimer);
    scannerCountdownTimer = null;
  }
}

function rememberRouteScroll() {
  const route = currentRoute();
  if (route !== "calc" && route !== "trade" && route !== "values" && route !== "tester" && route !== "predictions")
    return;
  const mainEl = document.querySelector("main.content");
  if (!mainEl) return;
  routeScrollTop[route] = mainEl.scrollTop || 0;
  if (route === "trade") {
    const left = mainEl.querySelector('.trade-picker[data-side="left"]');
    const right = mainEl.querySelector('.trade-picker[data-side="right"]');
    if (left) tradePickerScrollTop.left = left.scrollTop || 0;
    if (right) tradePickerScrollTop.right = right.scrollTop || 0;
  }
}

function restoreRouteScroll(route, mainEl) {
  if (!mainEl) return;
  const top = routeScrollTop[route];
  if (typeof top !== "number") return;
  requestAnimationFrame(() => {
    mainEl.scrollTop = top;
    if (route === "trade") {
      const left = mainEl.querySelector('.trade-picker[data-side="left"]');
      const right = mainEl.querySelector('.trade-picker[data-side="right"]');
      if (left) left.scrollTop = tradePickerScrollTop.left || 0;
      if (right) right.scrollTop = tradePickerScrollTop.right || 0;
    }
  });
}

/** @param {HTMLElement} root .view-scanner */
function updateScannerCountdown(root) {
  const row = root.querySelector("[data-scanner-countdown]");
  if (!row) return;
  const left = SCANNER_LAUNCH_AT_MS - Date.now();
  if (left <= 0) {
    if (scannerCountdownTimer) {
      clearInterval(scannerCountdownTimer);
      scannerCountdownTimer = null;
    }
    row.replaceChildren();
    const p = document.createElement("p");
    p.className = "scanner-countdown-done";
    p.textContent = t(lang, "scanner.countdown_done");
    row.appendChild(p);
    return;
  }
  const s = Math.floor(left / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  const dEl = row.querySelector("[data-cd-d]");
  const hEl = row.querySelector("[data-cd-h]");
  const mEl = row.querySelector("[data-cd-m]");
  const sEl = row.querySelector("[data-cd-s]");
  if (dEl) dEl.textContent = String(d);
  if (hEl) hEl.textContent = pad(h);
  if (mEl) mEl.textContent = pad(m);
  if (sEl) sEl.textContent = pad(sec);
}

function maybeRefocusToolbarSearch(route) {
  if (pendingToolbarFocusRoute !== route) return;
  pendingToolbarFocusRoute = null;
  requestAnimationFrame(() => {
    const rootEl = document.getElementById("app");
    const el = /** @type {HTMLInputElement | null} */ (
      rootEl?.querySelector(`main.content .toolbar input[data-td-search="${route}"]`) ??
      null
    );
    if (!el) return;
    el.focus();
    const len = el.value?.length ?? 0;
    try {
      el.setSelectionRange(len, len);
    } catch (_) {
      /* algunos navegadores con input no estándar */
    }
  });
}

function unitDisplayName(u) {
  return lang === "en" ? u.nombre_en || u.nombre : u.nombre;
}

const INCOMPATIBLE_VOTE_ICON_PATHS = [
  "assets/incompatible.jpg",
  "assets/incompatible.png",
  "assets/incompatible.jpeg",
  "assets/incompatible.svg",
];

function wrapIncompatibleIconFrame(img) {
  if (img.parentElement?.classList.contains("vote-icon-frame--incompatible")) {
    return img.parentElement;
  }
  const frame = document.createElement("span");
  frame.className = "vote-icon-frame vote-icon-frame--incompatible";
  frame.title = img.alt || t(lang, "values.vote_incompatibles");
  img.parentNode?.insertBefore(frame, img);
  frame.appendChild(img);
  return frame;
}

function createIncompatibleVoteFallback() {
  const frame = document.createElement("span");
  frame.className = "vote-icon-frame vote-icon-frame--incompatible";
  frame.title = t(lang, "values.vote_incompatibles");
  const span = document.createElement("span");
  span.className = "vote-icon vote-icon--incompatible-fallback";
  span.setAttribute("aria-hidden", "true");
  frame.appendChild(span);
  return frame;
}

function setVoteIconImg(img, voteNums) {
  if (voteNums.length <= 1) {
    const vn = voteNums[0] || 1;
    img.src = assetUrl(`assets/votos/voto${vn}.png`);
    img.onerror = () => {
      img.replaceWith(document.createTextNode(`V${vn}`));
    };
    return;
  }
  img.classList.add("vote-icon--incompatible");
  wrapIncompatibleIconFrame(img);
  let idx = 0;
  const tryNext = () => {
    if (idx >= INCOMPATIBLE_VOTE_ICON_PATHS.length) {
      const frame = img.parentElement;
      const fallback = createIncompatibleVoteFallback();
      if (frame?.classList.contains("vote-icon-frame--incompatible")) {
        frame.replaceWith(fallback);
      } else {
        img.replaceWith(fallback);
      }
      return;
    }
    img.src = assetUrl(INCOMPATIBLE_VOTE_ICON_PATHS[idx++]);
  };
  img.onerror = tryNext;
  tryNext();
}

function buildDemandScoreBadge(u) {
  const badge = document.createElement("span");
  const tier = demandScoreTier(u.demanda);
  badge.className = `demand-score demand-score--${tier}`;
  if (u.demanda === null || u.demanda === undefined) {
    badge.textContent = "—";
    badge.title = t(lang, "demand.hint_unknown");
    return badge;
  }
  badge.textContent = `${u.demanda}/10`;
  badge.title = `${t(lang, "demand.demand_score")}: ${u.demanda}/10`;
  return badge;
}

function buildStabilityBadge(u) {
  const badge = document.createElement("span");
  const stability = u.estabilidad || "fluctuating";
  badge.className = `demand-stability demand-stability--${stability}`;
  badge.textContent = stabilityLabel(lang, stability, t);
  return badge;
}

function buildUnitDemandRow(u, { compact = false } = {}) {
  const row = document.createElement("div");
  row.className = compact ? "unit-demand unit-demand--compact" : "unit-demand";
  row.appendChild(buildDemandScoreBadge(u));
  row.appendChild(buildStabilityBadge(u));
  return row;
}

function buildValuesDemandCell(u) {
  const td = document.createElement("td");
  td.className = "values-cell-demand";
  td.appendChild(buildDemandScoreBadge(u));
  return td;
}

function buildValuesStabilityCell(u) {
  const td = document.createElement("td");
  td.className = "values-cell-stability";
  td.appendChild(buildStabilityBadge(u));
  return td;
}

function buildValuesBaseValueCell(u) {
  const td = document.createElement("td");
  td.className = "values-cell-num values-cell-base";
  td.textContent = String(Number(u.valor) || 0);
  return td;
}

function calcSumForUnit(nombre) {
  const m = calcSelections[nombre];
  if (!m) return 0;
  return Object.values(m).reduce((a, b) => a + Math.max(0, b || 0), 0);
}

function tradeSumForUnit(side, nombre) {
  const map = side === "left" ? tradeLeftCounts : tradeRightCounts;
  const m = map[nombre];
  if (!m) return 0;
  return Object.values(m).reduce((a, b) => a + Math.max(0, b || 0), 0);
}

function voteValueForUnit(unit, voteKey) {
  const baseVal = Number(unit.valor) || 0;
  const uv = vote_values[unit.nombre] || {};
  if (voteKey === "voto13") {
    return uv.voto13 ?? uv.voto2 ?? baseVal;
  }
  return uv[voteKey] ?? baseVal;
}

function ownedInventoryEntryId(nombre, voteKey) {
  return `${nombre}|${voteKey}`;
}

function normalizeOwnedEntry(raw) {
  if (!raw || !raw.nombre || !raw.voteKey) return null;
  const qty = Math.max(1, Math.min(99, Number(raw.qty) || 1));
  return {
    id: raw.id || ownedInventoryEntryId(raw.nombre, raw.voteKey),
    nombre: raw.nombre,
    voteKey: raw.voteKey,
    qty,
  };
}

function loadOwnedInventory() {
  try {
    const raw = localStorage.getItem(OWNED_UNITS_STORAGE);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || !arr.length) return [];
    if (typeof arr[0] === "string") {
      return arr
        .filter(Boolean)
        .map((nombre) =>
          normalizeOwnedEntry({ nombre, voteKey: "voto1", qty: 1 }),
        )
        .filter(Boolean);
    }
    return arr.map(normalizeOwnedEntry).filter(Boolean);
  } catch {
    return [];
  }
}

function saveOwnedInventory() {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(
    OWNED_UNITS_STORAGE,
    JSON.stringify(tradeOwnedInventory),
  );
}

function resetTradeOwnedInventory() {
  tradeOwnedInventory = [];
  saveOwnedInventory();
}

function ownedInventoryTotalQty() {
  return tradeOwnedInventory.reduce((sum, e) => sum + e.qty, 0);
}

function ownedInventorySummary() {
  return {
    entries: tradeOwnedInventory.length,
    qty: ownedInventoryTotalQty(),
  };
}

function findUnitByName(nombre) {
  return units.find((u) => u.nombre === nombre) || null;
}

function adjustOwnedDraftEntry(draft, nombre, voteKey, deltaQty) {
  const id = ownedInventoryEntryId(nombre, voteKey);
  const idx = draft.findIndex((e) => e.id === id);
  if (idx >= 0) {
    const next = draft[idx].qty + deltaQty;
    if (next <= 0) draft.splice(idx, 1);
    else draft[idx].qty = Math.min(99, next);
    return;
  }
  if (deltaQty > 0) {
    draft.push(
      normalizeOwnedEntry({ id, nombre, voteKey, qty: deltaQty }),
    );
  }
}

function getOwnedQtyForVote(draft, nombre, voteKey) {
  const entry = draft.find(
    (e) => e.nombre === nombre && e.voteKey === voteKey,
  );
  return entry ? entry.qty : 0;
}

function ownedQtyForUnit(draft, nombre) {
  return draft
    .filter((e) => e.nombre === nombre)
    .reduce((sum, e) => sum + e.qty, 0);
}

function syncDraftToStorage(draft) {
  tradeOwnedInventory = draft
    .map((e) => normalizeOwnedEntry(e))
    .filter(Boolean);
  saveOwnedInventory();
}

function inventoryDraftSummary(draft) {
  return {
    entries: draft.length,
    qty: draft.reduce((sum, e) => sum + e.qty, 0),
  };
}

function patchInventoryDraftUI(draft, selectedNombre) {
  const body = tradeInventoryDialogEl?.querySelector("[data-inventory-body]");
  if (!body) return;

  const restricted = draft.length > 0;
  const summary = inventoryDraftSummary(draft);
  const mode = body.querySelector(".trade-inv-mode");
  if (mode) {
    mode.className = `trade-inv-mode ${restricted ? "trade-inv-mode--restricted" : "trade-inv-mode--open"}`.trim();
    mode.innerHTML = restricted
      ? `<strong>${escapeHtml(t(lang, "trade.inventory_mode_restricted"))}</strong><span>${escapeHtml(t(lang, "trade.inventory_count", summary))}</span>`
      : `<strong>${escapeHtml(t(lang, "trade.inventory_mode_open"))}</strong><span>${escapeHtml(t(lang, "trade.inventory_mode_open_hint"))}</span>`;
  }

  for (const tile of body.querySelectorAll(".trade-inv-tile")) {
    const nombre = tile.dataset.nombre;
    if (!nombre) continue;
    const ownedQty = ownedQtyForUnit(draft, nombre);
    tile.classList.toggle("trade-inv-tile--owned", ownedQty > 0);
    let badge = tile.querySelector(".trade-inv-tile-badge");
    if (ownedQty > 0) {
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "trade-inv-tile-badge";
        tile.appendChild(badge);
      }
      badge.textContent = `×${ownedQty}`;
    } else if (badge) {
      badge.remove();
    }
  }

  const detailSub = body.querySelector(".trade-inv-detail-hero-meta p.muted");
  if (detailSub && selectedNombre) {
    detailSub.textContent = t(lang, "trade.inventory_detail_sub", {
      qty: ownedQtyForUnit(draft, selectedNombre),
    });
  }

  for (const row of body.querySelectorAll(".trade-inv-vote-line")) {
    const vk = row.dataset.voteKey;
    const nombre = row.dataset.unitNombre;
    if (!vk || !nombre) continue;
    const qty = getOwnedQtyForVote(draft, nombre, vk);
    const cnt = row.querySelector(".cnt");
    const btnMinus = row.querySelector(".minus");
    const btnPlus = row.querySelector(".plus");
    if (cnt) cnt.textContent = String(qty);
    if (btnMinus) btnMinus.disabled = qty <= 0;
    if (btnPlus) btnPlus.disabled = qty >= 99;
  }
}

function isInventoryRestricted() {
  return tradeOwnedInventory.length > 0;
}

/** Votos compatibles con una unidad: cambian el valor o son HR/THO. */
function compatibleVotesForUnit(u) {
  const baseVal = Number(u.valor) || 0;
  return VOTE_DISPLAY_ORDER.filter((vn) => {
    if (ESSENTIAL_VOTE_NUMS.includes(vn)) return true;
    return voteValueForUnit(u, voteKey(vn)) !== baseVal;
  });
}

/** Agrupa votos compatibles por valor único (mantiene orden de display). */
function uniqueVoteEntriesForUnit(u) {
  const applicable = compatibleVotesForUnit(u);
  /** @type {Map<number, number[]>} */
  const byValue = new Map();
  for (const vn of applicable) {
    const v = voteValueForUnit(u, voteKey(vn));
    if (!byValue.has(v)) byValue.set(v, []);
    byValue.get(v).push(vn);
  }
  const seen = new Set();
  const out = [];
  for (const vn of applicable) {
    const v = voteValueForUnit(u, voteKey(vn));
    if (seen.has(v)) continue;
    seen.add(v);
    out.push({ value: v, voteNums: byValue.get(v) || [vn] });
  }
  return out;
}

/** Entradas de inventario: siempre incluye sin voto + variantes con voto. */
function inventoryVoteEntriesForUnit(u) {
  const baseVal = Number(u.valor) || 0;
  /** @type {Array<{ value: number, voteNums: number[] }>} */
  const entries = [{ value: baseVal, voteNums: [1] }];
  for (const entry of uniqueVoteEntriesForUnit(u)) {
    if (
      entry.voteNums.length === 1 &&
      entry.voteNums[0] === 1 &&
      entry.value === baseVal
    ) {
      continue;
    }
    entries.push(entry);
  }
  return entries;
}

function calcGrandTotal() {
  let total = 0;
  for (const u of units) {
    const m = calcSelections[u.nombre];
    if (!m) continue;
    for (const [vk, cnt] of Object.entries(m)) {
      if (cnt <= 0) continue;
      total += voteValueForUnit(u, vk) * cnt;
    }
  }
  return total;
}

function tradeSideTotal(countsMap) {
  let total = 0;
  for (const u of units) {
    const m = countsMap[u.nombre];
    if (!m) continue;
    for (const [vk, cnt] of Object.entries(m)) {
      if (cnt <= 0) continue;
      total += voteValueForUnit(u, vk) * cnt;
    }
  }
  return total;
}

function unitBaseTradeValue(u) {
  return voteValueForUnit(u, "voto1");
}

function avgDemandOfSide(countsMap) {
  let sum = 0;
  let n = 0;
  for (const u of units) {
    const m = countsMap[u.nombre];
    if (!m) continue;
    const qty = Object.values(m).reduce((a, b) => a + Math.max(0, b || 0), 0);
    if (qty <= 0 || u.demanda === null || u.demanda === undefined) continue;
    sum += u.demanda * qty;
    n += qty;
  }
  return n > 0 ? sum / n : null;
}

function givePriorityScore(u, listedVal = Number(u.valor) || 0) {
  const demand = u.demanda ?? 5;
  let score = (10 - demand) * 3.2;
  if (u.estabilidad === "dropping") score += 14;
  else if (u.estabilidad === "stable") score += 5;
  score -= hiddenValuePremium(u, listedVal) * 0.35;
  return score;
}

function hiddenValuePremium(u, listedVal) {
  return effectiveTradeValue(u.demanda, listedVal) - listedVal;
}

/** @param {Array<{u: Unit, voteKey: string, qty: number, val: number}>} picks */
function scoreTradeCombo(gap, totalVal, picks, avgRecvDemand) {
  const winMargin = gap - totalVal;
  if (winMargin <= 0) return null;

  const fillPct = Math.max(0, Math.min(100, Math.round((totalVal / gap) * 100)));
  let score = fillPct * 0.45;

  if (winMargin >= 1 && winMargin <= 12) score += 28;
  else if (winMargin <= 25) score += 16;
  else if (winMargin <= 45) score += 8;
  else score -= Math.min(24, (winMargin - 45) * 0.35);

  let giveDemandSum = 0;
  let giveN = 0;
  for (const p of picks) {
    giveDemandSum += (p.u.demanda ?? 5) * p.qty;
    giveN += p.qty;
    score += givePriorityScore(p.u, p.val) * p.qty * 0.85;
    score -= hiddenValuePremium(p.u, p.val) * p.qty * 0.55;
  }
  const avgGiveDemand = giveN > 0 ? giveDemandSum / giveN : 5;
  if (avgRecvDemand !== null) {
    score += (avgRecvDemand - avgGiveDemand) * 5.5;
  }

  if (giveN > 5) score -= (giveN - 5) * 2.5;

  return { score, winMargin, fillPct, avgGiveDemand };
}

/**
 * @typedef {{ u: Unit, voteKey: string, val: number, maxQty: number }} TradeSuggestItem
 * @typedef {{ u: Unit, voteKey: string, qty: number, val: number }} TradeSuggestPick
 * @typedef {{ picks: TradeSuggestPick[], totalVal: number, winMargin: number, fillPct: number, score: number, avgGiveDemand: number }} TradeSuggestCombo
 */

function buildTradeSuggestPool({ onlyOwned = false } = {}) {
  /** @type {TradeSuggestItem[]} */
  const pool = [];

  if (onlyOwned && tradeOwnedInventory.length > 0) {
    for (const entry of tradeOwnedInventory) {
      const u = findUnitByName(entry.nombre);
      if (!u) continue;
      const val = voteValueForUnit(u, entry.voteKey);
      if (val <= 0) continue;
      pool.push({
        u,
        voteKey: entry.voteKey,
        val,
        maxQty: entry.qty,
      });
    }
    return pool;
  }

  for (const u of units) {
    for (const { value, voteNums } of uniqueVoteEntriesForUnit(u)) {
      if (value <= 0) continue;
      const vk = voteKey(voteNums[0]);
      pool.push({ u, voteKey: vk, val: value, maxQty: 3 });
    }
  }

  return pool;
}

/** @returns {TradeSuggestCombo[]} */
function findTradeSuggestions(gap, { onlyOwned = false, avgRecvDemand = null } = {}) {
  if (gap <= 1) return [];

  const maxAdd = gap - 1;
  let minAdd = Math.max(1, Math.floor(gap * 0.52));
  const rawPool = buildTradeSuggestPool({ onlyOwned }).filter(
    (item) => item.val > 0 && item.val <= maxAdd,
  );
  if (!rawPool.length) return [];

  const pool = onlyOwned
    ? rawPool
    : [...rawPool]
        .sort(
          (a, b) =>
            givePriorityScore(b.u, b.val) -
            b.val * 0.015 -
            (givePriorityScore(a.u, a.val) - a.val * 0.015),
        )
        .slice(0, 32);

  /** @type {TradeSuggestCombo[]} */
  const results = [];
  const seen = new Set();

  function recordCombo(/** @type {TradeSuggestPick[]} */ picks, totalVal) {
    if (!picks.length || totalVal <= 0 || totalVal > maxAdd) return;
    if (totalVal < minAdd && totalVal < Math.max(1, maxAdd * 0.35)) return;
    const scored = scoreTradeCombo(gap, totalVal, picks, avgRecvDemand);
    if (!scored) return;
    const key = picks
      .map((p) => `${p.u.nombre}:${p.voteKey}x${p.qty}`)
      .sort()
      .join("|");
    if (seen.has(key)) return;
    seen.add(key);
    results.push({
      picks: picks.map((p) => ({ ...p })),
      totalVal,
      ...scored,
    });
  }

  function mergePick(/** @type {TradeSuggestPick[]} */ picks, item, qty) {
    if (qty <= 0) return;
    const existing = picks.find(
      (p) => p.u.nombre === item.u.nombre && p.voteKey === item.voteKey,
    );
    if (existing) existing.qty += qty;
    else picks.push({ u: item.u, voteKey: item.voteKey, qty, val: item.val });
  }

  function picksFromMap(/** @type {Map<string, TradeSuggestPick>} */ map) {
    return [...map.values()];
  }

  for (const item of pool) {
    for (let q = 1; q <= item.maxQty; q++) {
      const totalVal = item.val * q;
      if (totalVal > maxAdd) break;
      recordCombo(
        [{ u: item.u, voteKey: item.voteKey, qty: q, val: item.val }],
        totalVal,
      );
    }
  }

  for (let i = 0; i < pool.length; i++) {
    for (let j = i; j < pool.length; j++) {
      const a = pool[i];
      const b = pool[j];
      const maxA = a.maxQty;
      const maxB = j === i ? 0 : b.maxQty;
      for (let qa = 1; qa <= maxA; qa++) {
        for (let qb = 1; qb <= (j === i ? maxA - qa : maxB); qb++) {
          const totalVal = a.val * qa + b.val * qb;
          if (totalVal > maxAdd || qa + qb > 8) continue;
          /** @type {TradeSuggestPick[]} */
          const picks = [];
          mergePick(picks, a, qa);
          mergePick(picks, b, qb);
          recordCombo(picks, totalVal);
        }
      }
    }
  }

  const pool3 = pool.slice(0, 20);
  for (let i = 0; i < pool3.length; i++) {
    for (let j = i; j < pool3.length; j++) {
      for (let k = j; k < pool3.length; k++) {
        /** @type {Map<string, TradeSuggestPick>} */
        const map = new Map();
        for (const idx of [i, j, k]) {
          const item = pool3[idx];
          const key = `${item.u.nombre}|${item.voteKey}`;
          const cur = map.get(key);
          if (cur) cur.qty += 1;
          else
            map.set(key, {
              u: item.u,
              voteKey: item.voteKey,
              qty: 1,
              val: item.val,
            });
        }
        const picks = picksFromMap(map);
        const totalVal = picks.reduce((sum, p) => sum + p.val * p.qty, 0);
        const totalQty = picks.reduce((sum, p) => sum + p.qty, 0);
        if (totalQty > 8 || totalVal > maxAdd) continue;
        for (const p of picks) {
          const poolItem = pool3.find(
            (x) => x.u.nombre === p.u.nombre && x.voteKey === p.voteKey,
          );
          if (!poolItem || p.qty > poolItem.maxQty) {
            map.clear();
            break;
          }
        }
        if (map.size) recordCombo(picksFromMap(map), totalVal);
      }
    }
  }

  const cheapFirst = [...pool].sort((a, b) => a.val - b.val);
  for (const seed of cheapFirst.slice(0, 14)) {
    let totalVal = 0;
    let totalQty = 0;
    /** @type {TradeSuggestPick[]} */
    const picks = [];
    for (const item of [seed, ...cheapFirst]) {
      while (totalQty < 8 && totalVal + item.val <= maxAdd) {
        const cur = picks.find(
          (p) => p.u.nombre === item.u.nombre && p.voteKey === item.voteKey,
        );
        if (cur && cur.qty >= item.maxQty) break;
        mergePick(picks, item, 1);
        totalVal += item.val;
        totalQty += 1;
      }
    }
    if (picks.length) recordCombo(picks, totalVal);
  }

  if (!results.length && minAdd > 1) {
    minAdd = 1;
    for (const item of pool) {
      recordCombo(
        [{ u: item.u, voteKey: item.voteKey, qty: 1, val: item.val }],
        item.val,
      );
    }
  }

  return results
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.totalVal - a.totalVal ||
        a.winMargin - b.winMargin,
    )
    .slice(0, 6);
}

function ensureTradeInventoryDialog() {
  if (tradeInventoryDialogEl) return;
  const d = document.createElement("dialog");
  d.className = "trade-inventory-dialog trade-inv-dialog";
  d.innerHTML = `
    <div class="trade-inventory-dialog-inner trade-inv-dialog-inner" data-inventory-body></div>
    <div class="trade-inventory-dialog-foot trade-inv-dialog-foot">
      <button type="button" class="trade-inventory-clear" data-inventory-clear></button>
      <button type="button" class="trade-inventory-save" data-inventory-save></button>
    </div>`;
  document.body.appendChild(d);
  tradeInventoryDialogEl = d;
  d.addEventListener("click", (ev) => {
    if (ev.target === d) d.close();
  });
}

function buildInventoryUnitTile(u, draft, selectedNombre) {
  const ownedQty = ownedQtyForUnit(draft, u.nombre);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.dataset.nombre = u.nombre;
  btn.className = [
    "trade-inv-tile",
    cardRarityClass(u.rareza),
    selectedNombre === u.nombre ? "trade-inv-tile--active" : "",
    ownedQty > 0 ? "trade-inv-tile--owned" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const img = document.createElement("img");
  img.src = u.imagen ? assetUrl(u.imagen) : "";
  img.alt = unitDisplayName(u);
  img.loading = "lazy";

  const meta = document.createElement("div");
  meta.className = "trade-inv-tile-meta";
  const name = document.createElement("span");
  name.className = "trade-inv-tile-name";
  name.textContent = unitDisplayName(u);
  const val = document.createElement("span");
  val.className = "trade-inv-tile-val";
  val.textContent = String(u.valor);
  meta.appendChild(name);
  meta.appendChild(val);

  btn.appendChild(img);
  btn.appendChild(meta);

  if (ownedQty > 0) {
    const badge = document.createElement("span");
    badge.className = "trade-inv-tile-badge";
    badge.textContent = `×${ownedQty}`;
    btn.appendChild(badge);
  }

  return btn;
}

function buildInventoryDetailPanel(u, draft) {
  const panel = document.createElement("div");
  panel.className = `trade-inv-detail ${cardRarityClass(u.rareza)}`.trim();

  const hero = document.createElement("div");
  hero.className = "trade-inv-detail-hero";
  const face = document.createElement("div");
  face.className = "trade-inv-detail-face";
  const img = document.createElement("img");
  img.src = u.imagen ? assetUrl(u.imagen) : "";
  img.alt = unitDisplayName(u);
  face.appendChild(img);

  const heroMeta = document.createElement("div");
  heroMeta.className = "trade-inv-detail-hero-meta";
  const title = document.createElement("h4");
  title.textContent = unitDisplayName(u);
  const sub = document.createElement("p");
  sub.className = "muted";
  sub.textContent = t(lang, "trade.inventory_detail_sub", {
    qty: ownedQtyForUnit(draft, u.nombre),
  });
  heroMeta.appendChild(title);
  if (u.rareza) heroMeta.appendChild(buildRarityBadge(u.rareza));
  heroMeta.appendChild(sub);
  heroMeta.appendChild(buildUnitDemandRow(u, { compact: true }));

  hero.appendChild(face);
  hero.appendChild(heroMeta);
  panel.appendChild(hero);

  const voteHead = document.createElement("div");
  voteHead.className = "trade-inv-vote-head";
  voteHead.textContent = t(lang, "trade.inventory_votes_title");
  panel.appendChild(voteHead);

  const lines = document.createElement("div");
  lines.className = "vote-lines trade-inv-vote-lines";

  for (const { value, voteNums } of inventoryVoteEntriesForUnit(u)) {
    const vk = voteKey(voteNums[0]);
    const row = document.createElement("div");
    row.className = "vote-line trade-inv-vote-line";
    row.dataset.voteKey = vk;
    row.dataset.unitNombre = u.nombre;

    const voteImg = document.createElement("img");
    voteImg.className = "vote-icon";
    voteImg.alt =
      voteNums.length > 1
        ? t(lang, "values.vote_incompatibles")
        : voteDisplayLabel(lang, voteNums[0]);
    setVoteIconImg(voteImg, voteNums);

    const info = document.createElement("span");
    info.className = "val-info";
    const voteNames =
      voteNums.length > 1
        ? t(lang, "values.vote_incompatibles")
        : voteNums.map((vn) => voteDisplayLabel(lang, vn)).join(" · ");
    info.textContent = `${voteNames} · ${t(lang, "trade.value")}: ${value}`;

    const btnMinus = document.createElement("button");
    btnMinus.className = "minus";
    btnMinus.type = "button";
    btnMinus.textContent = "−";
    btnMinus.disabled = getOwnedQtyForVote(draft, u.nombre, vk) <= 0;

    const cnt = document.createElement("span");
    cnt.className = "cnt";
    cnt.textContent = String(getOwnedQtyForVote(draft, u.nombre, vk));

    const btnPlus = document.createElement("button");
    btnPlus.className = "plus";
    btnPlus.type = "button";
    btnPlus.textContent = "+";
    btnPlus.disabled = getOwnedQtyForVote(draft, u.nombre, vk) >= 99;

    btnMinus.onclick = () => {
      adjustOwnedDraftEntry(draft, u.nombre, vk, -1);
      patchInventoryDraftUI(draft, u.nombre);
    };
    btnPlus.onclick = () => {
      adjustOwnedDraftEntry(draft, u.nombre, vk, 1);
      patchInventoryDraftUI(draft, u.nombre);
    };

    row.appendChild(voteImg);
    row.appendChild(info);
    row.appendChild(btnMinus);
    row.appendChild(cnt);
    row.appendChild(btnPlus);
    lines.appendChild(row);
  }

  panel.appendChild(lines);
  return panel;
}

function renderTradeInventoryDialogBody(
  draft,
  searchQ = "",
  selectedNombre = tradeInventorySelectedUnit,
) {
  const scrollHost = tradeInventoryDialogEl?.querySelector(
    ".trade-inventory-dialog-inner",
  );
  const scrollTop = scrollHost?.scrollTop ?? 0;
  const body = tradeInventoryDialogEl.querySelector("[data-inventory-body]");
  body.innerHTML = "";

  const restricted = draft.length > 0;
  const summary = {
    entries: draft.length,
    qty: draft.reduce((sum, e) => sum + e.qty, 0),
  };

  const head = document.createElement("div");
  head.className = "trade-inv-dialog-head";
  const headTop = document.createElement("div");
  headTop.className = "trade-inv-dialog-head-top";
  const h = document.createElement("h3");
  h.textContent = t(lang, "trade.inventory_title");
  const closeHint = document.createElement("p");
  closeHint.className = "muted trade-inv-dialog-sub";
  closeHint.textContent = t(lang, "trade.inventory_hint");
  headTop.appendChild(h);
  headTop.appendChild(closeHint);

  const mode = document.createElement("div");
  mode.className = `trade-inv-mode ${restricted ? "trade-inv-mode--restricted" : "trade-inv-mode--open"}`.trim();
  mode.innerHTML = restricted
    ? `<strong>${escapeHtml(t(lang, "trade.inventory_mode_restricted"))}</strong><span>${escapeHtml(t(lang, "trade.inventory_count", summary))}</span>`
    : `<strong>${escapeHtml(t(lang, "trade.inventory_mode_open"))}</strong><span>${escapeHtml(t(lang, "trade.inventory_mode_open_hint"))}</span>`;

  head.appendChild(headTop);
  head.appendChild(mode);
  body.appendChild(head);

  const searchWrap = document.createElement("div");
  searchWrap.className = "trade-inventory-search trade-inv-search";
  const inp = document.createElement("input");
  inp.type = "text";
  inp.placeholder = t(lang, "trade.inventory_search");
  inp.value = searchQ;
  inp.autocomplete = "off";
  inp.spellcheck = false;
  searchWrap.appendChild(inp);
  body.appendChild(searchWrap);

  const layout = document.createElement("div");
  layout.className = "trade-inv-layout";

  const gridCol = document.createElement("div");
  gridCol.className = "trade-inv-grid-col";
  const gridLabel = document.createElement("div");
  gridLabel.className = "trade-inv-col-label";
  gridLabel.textContent = t(lang, "trade.inventory_units_label");
  gridCol.appendChild(gridLabel);

  const grid = document.createElement("div");
  grid.className = "trade-inv-grid";
  const list = getFilteredUnits(searchQ, "all");
  let firstVisible = "";

  for (const u of list) {
    if (!firstVisible) firstVisible = u.nombre;
    const tile = buildInventoryUnitTile(u, draft, selectedNombre);
    tile.onclick = () => {
      tradeInventorySelectedUnit = u.nombre;
      renderTradeInventoryDialogBody(draft, inp.value, u.nombre);
    };
    grid.appendChild(tile);
  }

  if (!selectedNombre || !list.some((u) => u.nombre === selectedNombre)) {
    selectedNombre = firstVisible;
    tradeInventorySelectedUnit = firstVisible;
  }

  gridCol.appendChild(grid);
  layout.appendChild(gridCol);

  const detailCol = document.createElement("div");
  detailCol.className = "trade-inv-detail-col";
  const detailLabel = document.createElement("div");
  detailLabel.className = "trade-inv-col-label";
  detailLabel.textContent = t(lang, "trade.inventory_detail_label");
  detailCol.appendChild(detailLabel);

  const selectedUnit = selectedNombre ? findUnitByName(selectedNombre) : null;
  if (selectedUnit) {
    detailCol.appendChild(buildInventoryDetailPanel(selectedUnit, draft));
  } else {
    const empty = document.createElement("div");
    empty.className = "trade-inv-detail-empty";
    empty.textContent = t(lang, "trade.inventory_detail_empty");
    detailCol.appendChild(empty);
  }

  layout.appendChild(detailCol);
  body.appendChild(layout);

  inp.addEventListener("input", () => {
    renderTradeInventoryDialogBody(draft, inp.value, tradeInventorySelectedUnit);
  });

  const clearBtn = tradeInventoryDialogEl.querySelector("[data-inventory-clear]");
  const saveBtn = tradeInventoryDialogEl.querySelector("[data-inventory-save]");
  clearBtn.textContent = t(lang, "trade.inventory_clear");
  saveBtn.textContent = t(lang, "trade.inventory_save");
  clearBtn.onclick = () => {
    draft.length = 0;
    tradeInventorySelectedUnit = "";
    resetTradeOwnedInventory();
    renderTradeInventoryDialogBody(draft, inp.value, "");
  };
  saveBtn.onclick = () => {
    syncDraftToStorage(draft);
    tradeInventoryDialogEl.close();
    renderApp();
  };

  requestAnimationFrame(() => {
    if (scrollHost) scrollHost.scrollTop = scrollTop;
  });
}

function openTradeInventoryDialog() {
  ensureTradeInventoryDialog();
  const draft = tradeOwnedInventory.map((e) => ({ ...e }));
  if (!tradeInventorySelectedUnit && draft.length > 0) {
    tradeInventorySelectedUnit = draft[0].nombre;
  }
  renderTradeInventoryDialogBody(draft, "", tradeInventorySelectedUnit);
  tradeInventoryDialogEl.showModal();
}

function buildSuggestUnitThumb(u, { small = false } = {}) {
  const wrap = document.createElement("div");
  wrap.className = `trade-suggest-thumb ${cardRarityClass(u.rareza)}${small ? " trade-suggest-thumb--sm" : ""}`.trim();
  const img = document.createElement("img");
  img.src = u.imagen ? assetUrl(u.imagen) : "";
  img.alt = unitDisplayName(u);
  wrap.appendChild(img);
  return wrap;
}

function formatSuggestPickLabel(pick) {
  const name = unitDisplayName(pick.u);
  const voteNum = Number(String(pick.voteKey).replace("voto", "")) || 1;
  const voteLbl = voteDisplayLabel(lang, voteNum);
  if (pick.qty > 1) {
    return `${name} ×${pick.qty} (${voteLbl})`;
  }
  return `${name} (${voteLbl})`;
}

function applyTradeSuggestion(picks) {
  for (const p of picks) {
    adjustTradeVotes("left", p.u.nombre, p.voteKey, p.qty);
  }
  renderApp();
}

function buildTradeSuggestionCard(sug, idx) {
  const item = document.createElement("article");
  item.className = `trade-suggest-card ${cardRarityClass(sug.picks[0].u.rareza)}`.trim();
  if (idx === 0) item.classList.add("trade-suggest-card--best");

  const header = document.createElement("div");
  header.className = "trade-suggest-header";

  const rank = document.createElement("span");
  rank.className = "trade-suggest-rank";
  rank.textContent =
    idx === 0
      ? t(lang, "trade.suggest_best")
      : t(lang, "trade.suggest_rank", { n: idx + 1 });

  const matchWrap = document.createElement("div");
  matchWrap.className = "trade-suggest-match";
  matchWrap.title = t(lang, "trade.suggest_match", { pct: sug.fillPct });
  const matchLbl = document.createElement("span");
  matchLbl.className = "trade-suggest-match-label";
  matchLbl.textContent = t(lang, "trade.suggest_match", { pct: sug.fillPct });
  const meter = document.createElement("div");
  meter.className = "trade-suggest-meter";
  const fill = document.createElement("div");
  fill.className = "trade-suggest-meter-fill";
  fill.style.width = `${sug.fillPct}%`;
  meter.appendChild(fill);
  matchWrap.appendChild(matchLbl);
  matchWrap.appendChild(meter);
  header.appendChild(rank);
  header.appendChild(matchWrap);

  const picksList = document.createElement("ul");
  picksList.className = "trade-suggest-picks";
  for (const pick of sug.picks) {
    const li = document.createElement("li");
    li.className = `trade-suggest-pick ${cardRarityClass(pick.u.rareza)}`.trim();

    const thumbWrap = buildSuggestUnitThumb(pick.u);
    if (pick.qty > 1) {
      const qtyTag = document.createElement("span");
      qtyTag.className = "trade-suggest-thumb-qty";
      qtyTag.textContent = `×${pick.qty}`;
      thumbWrap.appendChild(qtyTag);
    }

    const pickMeta = document.createElement("div");
    pickMeta.className = "trade-suggest-pick-meta";
    const pickName = document.createElement("span");
    pickName.className = "trade-suggest-pick-name";
    pickName.textContent = unitDisplayName(pick.u);
    const pickSub = document.createElement("span");
    pickSub.className = "trade-suggest-pick-sub muted";
    pickSub.textContent = formatSuggestPickLabel(pick);
    pickMeta.appendChild(pickName);
    pickMeta.appendChild(pickSub);

    const pickVal = document.createElement("span");
    pickVal.className = "trade-suggest-pick-val";
    pickVal.textContent = `${pick.val * pick.qty} pts`;

    li.appendChild(thumbWrap);
    li.appendChild(pickMeta);
    li.appendChild(pickVal);
    picksList.appendChild(li);
  }

  const stats = document.createElement("div");
  stats.className = "trade-suggest-stats";
  for (const [cls, label, value] of [
    [
      "trade-suggest-stat--val",
      lang === "es" ? "Oferta" : "Offer",
      `+${sug.totalVal} pts`,
    ],
    [
      "trade-suggest-stat--win",
      lang === "es" ? "Ventaja" : "Margin",
      `+${sug.winMargin} pts`,
    ],
    [
      "trade-suggest-stat--dem",
      t(lang, "demand.demand_score"),
      `${sug.avgGiveDemand.toFixed(1)}/10`,
    ],
  ]) {
    const stat = document.createElement("div");
    stat.className = `trade-suggest-stat ${cls}`;
    stat.innerHTML = `<span class="trade-suggest-stat-lbl">${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>`;
    stats.appendChild(stat);
  }

  const applyBtn = document.createElement("button");
  applyBtn.type = "button";
  applyBtn.className = "trade-suggest-apply";
  applyBtn.textContent = t(lang, "trade.suggest_apply");
  applyBtn.onclick = () => applyTradeSuggestion(sug.picks);

  item.appendChild(header);
  item.appendChild(picksList);
  item.appendChild(stats);
  item.appendChild(applyBtn);
  return item;
}

function buildTradeSuggestionsPanel(leftT, rightT) {
  const panel = document.createElement("section");
  panel.className = "trade-suggestions";

  const head = document.createElement("div");
  head.className = "trade-suggestions-head";
  const titleWrap = document.createElement("div");
  titleWrap.className = "trade-suggestions-title-wrap";
  const spark = document.createElement("span");
  spark.className = "trade-suggestions-spark";
  spark.textContent = "✦";
  const title = document.createElement("h4");
  title.textContent = t(lang, "trade.suggest_toggle");
  titleWrap.appendChild(spark);
  titleWrap.appendChild(title);

  const invActions = document.createElement("div");
  invActions.className = "trade-inventory-actions";

  const invSummary = ownedInventorySummary();

  const invBtn = document.createElement("button");
  invBtn.type = "button";
  invBtn.className = "trade-inventory-open-btn";
  invBtn.textContent = t(lang, "trade.inventory_open");
  if (invSummary.entries > 0) {
    invBtn.title = t(lang, "trade.suggest_from_owned", invSummary);
    const badge = document.createElement("span");
    badge.className = "trade-inventory-open-badge";
    badge.textContent = String(invSummary.qty);
    invBtn.appendChild(badge);
  }
  invBtn.onclick = () => openTradeInventoryDialog();

  const resetInvBtn = document.createElement("button");
  resetInvBtn.type = "button";
  resetInvBtn.className = "trade-inventory-reset-btn";
  resetInvBtn.textContent = t(lang, "trade.inventory_reset");
  resetInvBtn.disabled = !isInventoryRestricted();
  resetInvBtn.title = t(lang, "trade.inventory_reset_hint");
  resetInvBtn.onclick = () => {
    resetTradeOwnedInventory();
    renderApp();
  };

  invActions.appendChild(invBtn);
  invActions.appendChild(resetInvBtn);

  head.appendChild(titleWrap);
  head.appendChild(invActions);
  panel.appendChild(head);

  if (isInventoryRestricted()) {
    const savedNote = document.createElement("p");
    savedNote.className = "trade-inventory-saved muted";
    savedNote.textContent = t(lang, "trade.inventory_saved", invSummary);
    panel.appendChild(savedNote);
  } else {
    const openNote = document.createElement("p");
    openNote.className = "trade-inventory-open-note muted";
    openNote.textContent = t(lang, "trade.inventory_mode_open_short");
    panel.appendChild(openNote);
  }

  const rightHasUnits = Object.keys(tradeRightCounts).some((nombre) => {
    const m = tradeRightCounts[nombre];
    return m && Object.values(m).some((c) => (c || 0) > 0);
  });

  const gap = rightT - leftT;
  const status = document.createElement("div");
  status.className = "trade-suggestions-status";
  if (!rightHasUnits) {
    status.textContent = t(lang, "trade.suggest_empty_right");
    panel.appendChild(status);
    return panel;
  }
  if (gap <= 0) {
    status.textContent =
      gap === 0
        ? t(lang, "trade.suggest_fair")
        : t(lang, "trade.suggest_winning", { gap: Math.abs(gap) });
    panel.appendChild(status);
    return panel;
  }

  status.innerHTML = `<strong>${escapeHtml(
    t(lang, "trade.suggest_need_more", { gap, max: Math.max(1, gap - 1) }),
  )}</strong>`;
  panel.appendChild(status);

  const strategy = document.createElement("p");
  strategy.className = "trade-suggestions-strategy muted";
  strategy.textContent = t(lang, "trade.suggest_strategy");
  panel.appendChild(strategy);

  const avgDem = avgDemandOfSide(tradeRightCounts);
  if (avgDem !== null) {
    const recv = document.createElement("p");
    recv.className = "trade-suggestions-recv muted";
    recv.textContent = t(lang, "trade.suggest_receive", {
      dem: avgDem.toFixed(1),
    });
    panel.appendChild(recv);
  }

  const list = document.createElement("div");
  list.className = "trade-suggestions-list";
  const useOwned = isInventoryRestricted();
  let suggestions = [];
  try {
    suggestions = findTradeSuggestions(gap, {
      onlyOwned: useOwned,
      avgRecvDemand: avgDem,
    });
  } catch (err) {
    console.error("Trade suggestions failed:", err);
  }

  if (useOwned) {
    const ownedNote = document.createElement("p");
    ownedNote.className = "trade-suggestions-owned muted";
    ownedNote.textContent = t(lang, "trade.suggest_from_owned", invSummary);
    panel.appendChild(ownedNote);
  }

  if (!suggestions.length) {
    const empty = document.createElement("p");
    empty.className = "trade-suggestions-empty muted";
    empty.textContent = useOwned
      ? t(lang, "trade.suggest_no_owned")
      : t(lang, "trade.suggest_no_combo");
    panel.appendChild(empty);
    return panel;
  }

  suggestions.forEach((sug, idx) => {
    if (!sug.picks?.length) return;
    list.appendChild(buildTradeSuggestionCard(sug, idx));
  });

  panel.appendChild(list);
  return panel;
}

function pickActiveVote(existingMap, lastMap, nombre, fallbackFirst = "voto1") {
  const m = existingMap[nombre];
  let vk = lastMap[nombre];
  if (vk && m && (m[vk] || 0) > 0) return vk;
  if (m) {
    for (const key of Object.keys(m)) {
      if ((m[key] || 0) > 0) return key;
    }
    for (let i = 1; i <= 13; i++) {
      const k = `voto${i}`;
      if (m[k] !== undefined && m[k] > 0) return k;
    }
  }
  return fallbackFirst;
}

function adjustCalcVotes(nombre, voteKey, delta) {
  if (!voteKey.startsWith("voto")) return;
  if (!calcSelections[nombre]) calcSelections[nombre] = {};
  const cur = calcSelections[nombre][voteKey] || 0;
  const nv = cur + delta;
  if (nv <= 0) delete calcSelections[nombre][voteKey];
  else calcSelections[nombre][voteKey] = nv;
  if (Object.keys(calcSelections[nombre]).length === 0) {
    delete calcSelections[nombre];
    delete calcLastVote[nombre];
  } else calcLastVote[nombre] = voteKey;
}

function adjustTradeVotes(side, nombre, voteKey, delta) {
  const map = side === "left" ? tradeLeftCounts : tradeRightCounts;
  const lastMap = side === "left" ? tradeLeftLast : tradeRightLast;
  if (!voteKey.startsWith("voto")) return;
  if (!map[nombre]) map[nombre] = {};
  const cur = map[nombre][voteKey] || 0;
  const nv = cur + delta;
  if (nv <= 0) delete map[nombre][voteKey];
  else map[nombre][voteKey] = nv;
  if (Object.keys(map[nombre]).length === 0) {
    delete map[nombre];
    delete lastMap[nombre];
  } else lastMap[nombre] = voteKey;
}

function cardRarityClass(rareza) {
  const r = normalizeRarity(rareza);
  const map = {
    epic: "epic",
    legendary: "legendary",
    mythic: "mythic",
    "special grade": "sg",
    "ascended grade": "asc",
    aniversary: "aniv",
  };
  return map[r] || "";
}

function compareUnits(a, b) {
  const ra = rarityRank(a.rareza);
  const rb = rarityRank(b.rareza);
  if (ra !== rb) return rb - ra;
  const dv = (Number(b.valor) || 0) - (Number(a.valor) || 0);
  if (dv !== 0) return dv;
  return a.nombre.localeCompare(b.nombre, "es", { sensitivity: "base" });
}

function getFilteredUnits(q, rarityFilter = "all") {
  const query = (q || "").toLowerCase().trim();
  let list = [...units].sort(compareUnits);
  if (rarityFilter && rarityFilter !== "all") {
    list = list.filter((u) => normalizeRarity(u.rareza) === rarityFilter);
  }
  if (!query) return list;
  const tokens = query.split(/\s+/).filter(Boolean);
  return list.filter((u) => {
    const n_es = u.nombre.toLowerCase();
    const n_en = (u.nombre_en || "").toLowerCase();
    const every = /** @type {(s:string)=>boolean} */ (s) =>
      tokens.every((tok) => s.includes(tok));
    return every(n_es) || every(n_en);
  });
}

function filterSortUnits(q) {
  return getFilteredUnits(q, "all");
}

function testerAccessAllowed() {
  return testerIpStatus === "allowed";
}

async function resolveTesterIpAccess() {
  if (!edgeFunctionsConfigured()) {
    testerIpStatus = "denied";
    return;
  }
  testerIpStatus = "pending";
  try {
    const data = await callEdgeFunction("tester-access", { method: "GET" });
    testerIpStatus = data?.allowed ? "allowed" : "denied";
  } catch {
    testerIpStatus = "denied";
  }
}

function buildRarityBadge(rareza) {
  const badge = document.createElement("span");
  badge.className = `rarity-badge ${cardRarityClass(rareza)}`.trim();
  badge.textContent = rarityLabel(lang, rareza);
  return badge;
}

/** @param {"calc"|"trade"|"values"} route */
function getRarityFilterForRoute(route) {
  if (route === "calc") return calcRarityFilter;
  if (route === "values") return valuesRarityFilter;
  return tradeRarityFilter;
}

/** @param {"calc"|"trade"|"values"} route */
function setRarityFilterForRoute(route, value) {
  if (route === "calc") calcRarityFilter = value;
  else if (route === "values") valuesRarityFilter = value;
  else tradeRarityFilter = value;
  const key =
    route === "calc"
      ? "tdhub_calc_rarity"
      : route === "values"
        ? "tdhub_values_rarity"
        : "tdhub_trade_rarity";
  localStorage.setItem(key, value);
}

/** @param {"calc"|"trade"|"values"} route */
function buildRarityFilterBar(route) {
  const current = getRarityFilterForRoute(route);
  const bar = document.createElement("div");
  bar.className = "rarity-filter-bar";

  const lbl = document.createElement("span");
  lbl.className = "rarity-filter-label";
  lbl.textContent = t(lang, "filter.rarity_label");

  const chips = document.createElement("div");
  chips.className = "rarity-filter-chips";

  const allBtn = document.createElement("button");
  allBtn.type = "button";
  allBtn.className = `rarity-chip rarity-chip--all${current === "all" ? " active" : ""}`;
  allBtn.textContent = t(lang, "filter.all");
  allBtn.onclick = () => {
    setRarityFilterForRoute(route, "all");
    pendingToolbarFocusRoute = route;
    renderApp();
  };
  chips.appendChild(allBtn);

  for (const id of RARITY_IDS_DESC) {
    const btn = document.createElement("button");
    btn.type = "button";
    const cls = cardRarityClass(id);
    btn.className = `rarity-chip ${cls}${current === id ? " active" : ""}`.trim();
    btn.textContent = rarityLabel(lang, id);
    btn.onclick = () => {
      setRarityFilterForRoute(route, id);
      pendingToolbarFocusRoute = route;
      renderApp();
    };
    chips.appendChild(btn);
  }

  bar.appendChild(lbl);
  bar.appendChild(chips);
  return bar;
}

function buildPageHeader(titleKey, subtitleKey) {
  const head = document.createElement("header");
  head.className = "page-header";
  const h = document.createElement("h2");
  h.textContent = t(lang, titleKey);
  const sub = document.createElement("p");
  sub.className = "page-header-sub muted";
  sub.textContent = t(lang, subtitleKey);
  head.appendChild(h);
  head.appendChild(sub);
  return head;
}

/** @returns {Record<string, number>} */
function votesMapForModal() {
  const { mode, unitName, side } = modalCtx;
  if (mode === "calc") return { ...(calcSelections[unitName] || {}) };
  const m = side === "left" ? tradeLeftCounts : tradeRightCounts;
  return { ...(m[unitName] || {}) };
}

/** @returns {HTMLElement} */
function buildVoteLines(u) {
  const lines = document.createElement("div");
  lines.className = "vote-lines";

  let rowNodes = [];

  function refreshCounters() {
    const cur = votesMapForModal();
    for (const { vk, cnt } of rowNodes) {
      cnt.textContent = String(cur[vk] || 0);
    }
  }

  for (const vn of VOTE_DISPLAY_ORDER) {
    const vk = voteKey(vn);
    const val = voteValueForUnit(u, vk);
    const row = document.createElement("div");
    row.className = "vote-line";

    const img = document.createElement("img");
    img.alt = voteDisplayLabel(lang, vn);
    img.src = assetUrl(`assets/votos/voto${vn}.png`);
    img.onerror = () => {
      img.replaceWith(document.createTextNode(`V${vn}`));
    };

    const info = document.createElement("span");
    info.className = "val-info";
    info.textContent = `${voteDisplayLabel(lang, vn)} · ${t(lang, "trade.value")}: ${val}`;

    const btnMinus = document.createElement("button");
    btnMinus.className = "minus";
    btnMinus.type = "button";
    btnMinus.textContent = "−";
    btnMinus.onclick = () => {
      if (modalCtx.mode === "calc")
        adjustCalcVotes(modalCtx.unitName, vk, -1);
      else adjustTradeVotes(modalCtx.side, modalCtx.unitName, vk, -1);
      refreshCounters();
      renderApp();
    };

    const cnt = document.createElement("span");
    cnt.className = "cnt";

    const btnPlus = document.createElement("button");
    btnPlus.className = "plus";
    btnPlus.type = "button";
    btnPlus.textContent = "+";
    btnPlus.onclick = () => {
      if (modalCtx.mode === "calc")
        adjustCalcVotes(modalCtx.unitName, vk, 1);
      else adjustTradeVotes(modalCtx.side, modalCtx.unitName, vk, 1);
      refreshCounters();
      renderApp();
    };

    row.appendChild(img);
    row.appendChild(info);
    row.appendChild(btnMinus);
    row.appendChild(cnt);
    row.appendChild(btnPlus);
    lines.appendChild(row);
    rowNodes.push({ vk, cnt });
  }
  refreshCounters();
  return lines;
}

function ensureVoteDialog() {
  if (voteDialogEl) return;
  const d = document.createElement("dialog");
  d.className = "vote-sheet";
  d.innerHTML = `
    <div class="vote-sheet-inner" data-vote-sheet-body></div>
    <div class="close-row">
      <button type="button" data-close-sheet></button>
    </div>`;
  document.body.appendChild(d);
  voteDialogEl = d;
  d.querySelector("[data-close-sheet]").addEventListener("click", () => d.close());
  d.addEventListener("click", (ev) => {
    if (ev.target === d) d.close();
  });
}

function openVoteSheet(mode, unit, side) {
  ensureVoteDialog();
  modalCtx = {
    mode,
    unitName: unit.nombre,
    side: side || "left",
    unit,
  };
  const body = voteDialogEl.querySelector("[data-vote-sheet-body]");
  body.innerHTML = "";
  const st =
    mode === "trade"
      ? side === "left"
        ? t(lang, "trade.side_left")
        : t(lang, "trade.side_right")
      : "";
  const h = document.createElement("h3");
  h.textContent = st ? `${unit.nombre} ${st}` : unit.nombre;
  body.appendChild(h);
  body.appendChild(buildVoteLines(unit));

  voteDialogEl.querySelector("[data-close-sheet]").textContent =
    t(lang, "calc.close");

  voteDialogEl.showModal();
}

/**
 * Una entrada por (unidad, tipo de voto) con cantidad > 0.
 * Orden estable: nombre ES, luego número de voto.
 */
function tradeInventoryEntries(sideName) {
  const cmap = sideName === "left" ? tradeLeftCounts : tradeRightCounts;
  const out = [];
  for (const u of units) {
    const m = cmap[u.nombre];
    if (!m) continue;
    for (let i = 1; i <= 13; i++) {
      const voteKey = `voto${i}`;
      const qty = m[voteKey] || 0;
      if (qty <= 0) continue;
      out.push({ unit: u, voteKey, qty });
    }
  }
  out.sort((a, b) => {
    const unitCmp = compareUnits(a.unit, b.unit);
    if (unitCmp !== 0) return unitCmp;
    const ai = Number(String(a.voteKey).replace(/\D/g, "")) || 0;
    const bi = Number(String(b.voteKey).replace(/\D/g, "")) || 0;
    return ai - bi;
  });
  return out;
}

function buildTradeInventory(sideName) {
  const section = document.createElement("section");
  section.className = `trade-inventory trade-inventory--${sideName}`;

  const label = document.createElement("div");
  label.className = "trade-inventory-label";
  label.textContent =
    sideName === "left"
      ? t(lang, "trade.stock_you")
      : t(lang, "trade.stock_opponent");

  const strip = document.createElement("div");
  strip.className = "trade-inventory-strip";

  const entries = tradeInventoryEntries(sideName);
  if (entries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "trade-inventory-empty muted";
    empty.textContent = t(lang, "trade.stock_empty");
    strip.appendChild(empty);
  } else {
    for (const { unit: u, voteKey, qty } of entries) {
      const slot = document.createElement("div");
      slot.className = `trade-inv-slot ${cardRarityClass(u.rareza)}`.trim();
      const vi = Number(String(voteKey).replace(/\D/g, "")) || 0;
      slot.title =
        vi > 0
          ? `${unitDisplayName(u)} · V${vi}`
          : unitDisplayName(u);
      slot.role = "button";
      slot.tabIndex = 0;
      slot.setAttribute("aria-label", `${unitDisplayName(u)} · click para quitar 1`);
      slot.addEventListener("click", () => {
        adjustTradeVotes(sideName, u.nombre, voteKey, -1);
        renderApp();
      });
      slot.addEventListener("keydown", (ev) => {
        if (ev.key !== "Enter" && ev.key !== " ") return;
        ev.preventDefault();
        adjustTradeVotes(sideName, u.nombre, voteKey, -1);
        renderApp();
      });

      const img = document.createElement("img");
      img.className = "trade-inv-slot-img";
      img.src = u.imagen ? assetUrl(u.imagen) : "";
      img.alt = "";

      const vimg = document.createElement("img");
      vimg.className = "trade-inv-slot-vote";
      vimg.src = assetUrl(`assets/votos/${voteKey}.png`);
      vimg.alt = voteKey;

      const qb = document.createElement("span");
      qb.className = "trade-inv-slot-qty";
      qb.textContent = qty >= 100 ? "99+" : String(qty);

      vimg.onerror = () => {
        vimg.remove();
        const fb = document.createElement("span");
        fb.className = "trade-inv-slot-vote trade-inv-slot-vote--fallback";
        fb.textContent = vi > 0 ? String(vi) : "?";
        slot.insertBefore(fb, qb);
      };

      slot.appendChild(img);
      slot.appendChild(vimg);
      slot.appendChild(qb);
      strip.appendChild(slot);
    }
  }

  section.appendChild(label);
  section.appendChild(strip);
  return section;
}

function calcVoteIconSrc(nombre) {
  const vk = calcLastVote[nombre];
  return vk ? assetUrl(`assets/votos/${vk}.png`) : assetUrl("assets/vote_icon.png");
}

function tradeVoteIconSrc(side, nombre) {
  const lm = side === "left" ? tradeLeftLast : tradeRightLast;
  const vk = lm[nombre];
  return vk ? assetUrl(`assets/votos/${vk}.png`) : assetUrl("assets/vote_icon.png");
}

function buildCalcView() {
  const q = lastSearchCalc;
  const wrap = document.createElement("div");
  wrap.className = "view-calc";

  wrap.appendChild(buildPageHeader("calc.title", "calc.subtitle"));

  const tb = document.createElement("div");
  tb.className = "toolbar";
  const inp = document.createElement("input");
  inp.type = "text";
  inp.setAttribute("data-td-search", "calc");
  inp.placeholder = t(lang, "calc.search");
  inp.value = q;
  inp.autocomplete = "off";
  inp.spellcheck = false;
  inp.inputMode = "search";
  inp.addEventListener("input", () => {
    lastSearchCalc = inp.value;
    pendingToolbarFocusRoute = "calc";
    renderApp();
  });

  const pill = document.createElement("span");
  pill.className = "total-pill";
  pill.textContent = `${t(lang, "calc.total")}: ${calcGrandTotal()}`;

  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "toolbar-btn-calc-clear";
  clearBtn.textContent = t(lang, "calc.clear_all");
  clearBtn.onclick = () => {
    for (const k of Object.keys(calcSelections)) delete calcSelections[k];
    for (const k of Object.keys(calcLastVote)) delete calcLastVote[k];
    renderApp();
  };

  tb.appendChild(inp);
  tb.appendChild(pill);
  tb.appendChild(clearBtn);

  const grid = document.createElement("div");
  grid.className = "unit-grid";

  wrap.appendChild(tb);
  wrap.appendChild(buildRarityFilterBar("calc"));

  for (const u of getFilteredUnits(q, calcRarityFilter)) {
    const sum = calcSumForUnit(u.nombre);
    const card = document.createElement("div");
    card.className = `unit-card ${cardRarityClass(u.rareza)}`.trim();

    const head = document.createElement("div");
    head.className = "unit-card-head";

    const vb = document.createElement("button");
    vb.type = "button";
    vb.className = "vote-mini";
    vb.title = t(lang, "calc.reopen");
    const vbImg = document.createElement("img");
    vbImg.src = calcVoteIconSrc(u.nombre);
    vbImg.alt = "";
    vb.appendChild(vbImg);
    vb.onclick = () => openVoteSheet("calc", u, null);

    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = String(sum);
    head.appendChild(vb);
    head.appendChild(badge);

    const face = document.createElement("img");
    face.className = "face";
    face.src = u.imagen ? assetUrl(u.imagen) : "";
    face.alt = "";

    const meta = document.createElement("div");
    meta.className = "unit-meta";
    const name = document.createElement("div");
    name.className = "unit-name";
    name.textContent = unitDisplayName(u);
    meta.appendChild(name);
    if (u.rareza) meta.appendChild(buildRarityBadge(u.rareza));

    const val = document.createElement("div");
    val.className = "unit-value";
    val.textContent = String(u.valor);

    const ctl = document.createElement("div");
    ctl.className = "controls";
    const bminus = document.createElement("button");
    bminus.className = "round minus";
    bminus.type = "button";
    bminus.textContent = "−";
    bminus.onclick = () => {
      const vk = pickActiveVote(calcSelections, calcLastVote, u.nombre, "voto1");
      adjustCalcVotes(u.nombre, vk, -1);
      renderApp();
    };
    const bplus = document.createElement("button");
    bplus.type = "button";
    bplus.className = "round plus";
    bplus.textContent = "+";
    bplus.onclick = () => {
      const vk =
        calcLastVote[u.nombre] ||
        pickActiveVote(calcSelections, calcLastVote, u.nombre, "voto1");
      adjustCalcVotes(u.nombre, vk, 1);
      renderApp();
    };
    ctl.appendChild(bminus);
    ctl.appendChild(bplus);

    card.appendChild(head);
    card.appendChild(face);
    card.appendChild(meta);
    card.appendChild(val);
    card.appendChild(buildUnitDemandRow(u, { compact: true }));
    card.appendChild(ctl);
    grid.appendChild(card);
  }

  wrap.appendChild(grid);
  return wrap;
}

function buildTradeUnitCard(u, sideName) {
  const cmap = sideName === "left" ? tradeLeftCounts : tradeRightCounts;
  const lmap = sideName === "left" ? tradeLeftLast : tradeRightLast;
  const sum = tradeSumForUnit(sideName, u.nombre);

  const card = document.createElement("div");
  card.className = `unit-card trade-unit-card ${cardRarityClass(u.rareza)}`.trim();

  const head = document.createElement("div");
  head.className = "unit-card-head";

  const vb = document.createElement("button");
  vb.type = "button";
  vb.className = "vote-mini";
  vb.title = t(lang, "calc.reopen");
  const vbImg = document.createElement("img");
  vbImg.src = tradeVoteIconSrc(sideName, u.nombre);
  vbImg.alt = "";
  vb.appendChild(vbImg);
  vb.onclick = () => openVoteSheet("trade", u, sideName);

  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = String(sum);
  head.appendChild(vb);
  head.appendChild(badge);

  const face = document.createElement("img");
  face.className = "face";
  face.src = u.imagen ? assetUrl(u.imagen) : "";
  face.alt = "";

  const meta = document.createElement("div");
  meta.className = "unit-meta";
  const name = document.createElement("div");
  name.className = "unit-name";
  name.textContent = unitDisplayName(u);
  meta.appendChild(name);
  if (u.rareza) meta.appendChild(buildRarityBadge(u.rareza));

  const val = document.createElement("div");
  val.className = "unit-value";
  val.textContent = String(u.valor);

  const ctl = document.createElement("div");
  ctl.className = "controls";
  const bminus = document.createElement("button");
  bminus.className = "round minus";
  bminus.type = "button";
  bminus.textContent = "−";
  bminus.onclick = () => {
    const vk = pickActiveVote(cmap, lmap, u.nombre, "voto1");
    adjustTradeVotes(sideName, u.nombre, vk, -1);
    renderApp();
  };
  const bplus = document.createElement("button");
  bplus.type = "button";
  bplus.className = "round plus";
  bplus.textContent = "+";
  bplus.onclick = () => {
    const vk =
      lmap[u.nombre] || pickActiveVote(cmap, lmap, u.nombre, "voto1");
    adjustTradeVotes(sideName, u.nombre, vk, 1);
    renderApp();
  };
  ctl.appendChild(bminus);
  ctl.appendChild(bplus);

  card.appendChild(head);
  card.appendChild(face);
  card.appendChild(meta);
  card.appendChild(val);
  card.appendChild(buildUnitDemandRow(u, { compact: true }));
  card.appendChild(ctl);
  return card;
}

function buildTradeHalf(sideName, filtered) {
  const col = document.createElement("div");
  col.className = `trade-col ${sideName}`;

  const head = document.createElement("div");
  head.className = "trade-col-head";
  const h = document.createElement("h3");
  h.textContent =
    sideName === "left" ? t(lang, "trade.left") : t(lang, "trade.right");
  const sideTotal = document.createElement("span");
  sideTotal.className = `trade-side-total trade-side-total--${sideName}`;
  sideTotal.textContent = String(
    tradeSideTotal(sideName === "left" ? tradeLeftCounts : tradeRightCounts),
  );
  head.appendChild(h);
  head.appendChild(sideTotal);
  col.appendChild(head);

  const invCap = document.createElement("div");
  invCap.className = "trade-inventory-caption muted";
  invCap.textContent = t(lang, "trade.inventory_caption");
  col.appendChild(invCap);
  col.appendChild(buildTradeInventory(sideName));

  const cap = document.createElement("div");
  cap.className = "trade-picker-caption muted";
  cap.textContent = t(lang, "trade.picker_caption");
  col.appendChild(cap);

  const gridWrap = document.createElement("div");
  gridWrap.className = "trade-picker trade-unit-grid";
  gridWrap.dataset.side = sideName;

  for (const u of filtered) {
    gridWrap.appendChild(buildTradeUnitCard(u, sideName));
  }
  col.appendChild(gridWrap);

  return col;
}

function buildTradeView() {
  const q = lastSearchTrade;
  const wrap = document.createElement("div");
  wrap.className = "view-trade";

  wrap.appendChild(buildPageHeader("trade.title", "trade.subtitle"));

  const actionTb = document.createElement("div");
  actionTb.className = "toolbar toolbar--trade-actions";

  const suggestBtn = document.createElement("button");
  suggestBtn.type = "button";
  suggestBtn.className = "toolbar-btn-suggest";
  suggestBtn.textContent = tradeSuggestionsOpen
    ? t(lang, "trade.suggest_hide")
    : t(lang, "trade.suggest_toggle");
  suggestBtn.onclick = () => {
    tradeSuggestionsOpen = !tradeSuggestionsOpen;
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(
        TRADE_SUGGEST_OPEN_KEY,
        tradeSuggestionsOpen ? "1" : "0",
      );
    }
    renderApp();
  };

  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "toolbar-btn-clear";
  clearBtn.textContent = t(lang, "trade.clear");
  clearBtn.onclick = () => {
    for (const k of Object.keys(tradeLeftCounts)) delete tradeLeftCounts[k];
    for (const k of Object.keys(tradeRightCounts)) delete tradeRightCounts[k];
    for (const k of Object.keys(tradeLeftLast)) delete tradeLeftLast[k];
    for (const k of Object.keys(tradeRightLast)) delete tradeRightLast[k];
    lastTradeBarFlex = { left: 1, right: 1 };
    renderApp();
  };

  actionTb.appendChild(suggestBtn);
  actionTb.appendChild(clearBtn);

  const leftT = tradeSideTotal(tradeLeftCounts);
  const rightT = tradeSideTotal(tradeRightCounts);
  const diff = Math.abs(leftT - rightT);

  const searchTb = document.createElement("div");
  searchTb.className = "toolbar toolbar--trade-search";
  const inp = document.createElement("input");
  inp.type = "text";
  inp.setAttribute("data-td-search", "trade");
  inp.placeholder = t(lang, "trade.search");
  inp.value = q;
  inp.autocomplete = "off";
  inp.spellcheck = false;
  inp.inputMode = "search";
  inp.addEventListener("input", () => {
    lastSearchTrade = inp.value;
    pendingToolbarFocusRoute = "trade";
    renderApp();
  });
  searchTb.appendChild(inp);

  const grid = document.createElement("div");
  grid.className = "trade-shell";
  const filt = getFilteredUnits(q, tradeRarityFilter);

  wrap.appendChild(actionTb);
  wrap.appendChild(buildTradeCompareBar(leftT, rightT, diff));
  wrap.appendChild(searchTb);
  if (tradeSuggestionsOpen) {
    wrap.appendChild(buildTradeSuggestionsPanel(leftT, rightT));
  }
  wrap.appendChild(buildRarityFilterBar("trade"));
  grid.appendChild(buildTradeHalf("left", filt));
  grid.appendChild(buildTradeHalf("right", filt));
  wrap.appendChild(grid);
  return wrap;
}

function buildTradeCompareBar(leftT, rightT, diff) {
  const total = leftT + rightT;
  const leftFlex = total > 0 ? leftT : 1;
  const rightFlex = total > 0 ? rightT : 1;
  const leftPct = total > 0 ? Math.round((leftT / total) * 100) : 50;
  const rightPct = total > 0 ? 100 - leftPct : 50;

  const wrap = document.createElement("div");
  wrap.className = "trade-balance trade-balance--footer";

  const head = document.createElement("div");
  head.className = "trade-balance-head";

  const leftSide = document.createElement("div");
  leftSide.className = "trade-balance-side trade-balance-side--you";
  leftSide.innerHTML = `
    <span class="trade-balance-label">${escapeHtml(t(lang, "trade.left_short"))}</span>
    <span class="trade-balance-value">${leftT}</span>`;

  const vs = document.createElement("div");
  vs.className = "trade-balance-vs";
  vs.textContent = "VS";

  const rightSide = document.createElement("div");
  rightSide.className = "trade-balance-side trade-balance-side--them";
  rightSide.innerHTML = `
    <span class="trade-balance-label">${escapeHtml(t(lang, "trade.right_short"))}</span>
    <span class="trade-balance-value">${rightT}</span>`;

  head.appendChild(leftSide);
  head.appendChild(vs);
  head.appendChild(rightSide);

  const meter = document.createElement("div");
  meter.className = "trade-balance-meter";

  const leftFill = document.createElement("div");
  leftFill.className = "trade-balance-fill trade-balance-fill--you";
  leftFill.style.flex = String(lastTradeBarFlex.left);

  const notch = document.createElement("div");
  notch.className = "trade-balance-notch";

  const rightFill = document.createElement("div");
  rightFill.className = "trade-balance-fill trade-balance-fill--them";
  rightFill.style.flex = String(lastTradeBarFlex.right);

  meter.appendChild(leftFill);
  meter.appendChild(notch);
  meter.appendChild(rightFill);

  requestAnimationFrame(() => {
    leftFill.style.flex = String(leftFlex);
    rightFill.style.flex = String(rightFlex);
    lastTradeBarFlex = { left: leftFlex, right: rightFlex };
  });

  const meta = document.createElement("div");
  meta.className = "trade-balance-meta";

  const leftPctEl = document.createElement("span");
  leftPctEl.className = "trade-balance-pct trade-balance-pct--you";
  leftPctEl.textContent = `${leftPct}%`;

  const diffEl = document.createElement("span");
  diffEl.className = "trade-balance-diff";
  diffEl.textContent =
    total > 0 ? `${t(lang, "trade.diff")}: ${diff}` : t(lang, "trade.bar_empty");

  const rightPctEl = document.createElement("span");
  rightPctEl.className = "trade-balance-pct trade-balance-pct--them";
  rightPctEl.textContent = `${rightPct}%`;

  meta.appendChild(leftPctEl);
  meta.appendChild(diffEl);
  meta.appendChild(rightPctEl);

  wrap.appendChild(head);
  wrap.appendChild(meter);
  wrap.appendChild(meta);
  return wrap;
}

function playPageIntro() {
  if (hasPlayedPageIntro || typeof document === "undefined") return;
  hasPlayedPageIntro = true;

  const overlay = document.createElement("div");
  overlay.className = "page-intro";
  overlay.innerHTML = `
    <div class="page-intro-noise" aria-hidden="true"></div>
    <div class="page-intro-glow" aria-hidden="true"></div>
    <div class="page-intro-content">
      <p class="page-intro-kicker">SORCERER TD</p>
      <h2 class="page-intro-title">Calculator</h2>
      <div class="page-intro-line" aria-hidden="true"></div>
    </div>`;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("page-intro--active"));
  window.setTimeout(() => {
    overlay.classList.add("page-intro--exit");
    window.setTimeout(() => overlay.remove(), 900);
  }, 1100);
}

function buildHomeView() {
  const d = document.createElement("div");
  d.className = "view-home";

  const hero = document.createElement("section");
  hero.className = "home-hero";
  hero.innerHTML = `
    <p class="home-hero-kicker">${escapeHtml(t(lang, "main.home_tagline"))}</p>
    <h1 class="home-hero-title">${escapeHtml(t(lang, "main.bienvenida"))}</h1>
    <p class="home-hero-sub">${escapeHtml(t(lang, "main.home_subtitle"))}</p>
    <div class="home-hero-stats">
      <span class="home-hero-stat-pill"><strong>${units.length}</strong> ${escapeHtml(t(lang, "main.home_stat_units"))}</span>
      <span class="home-hero-stat-pill"><strong>13</strong> ${escapeHtml(t(lang, "main.home_stat_votes"))}</span>
      <span class="home-hero-badge home-hero-badge--live">${escapeHtml(t(lang, "main.home_stat_live"))}</span>
    </div>
    <p class="home-hero-note">${escapeHtml(t(lang, "main.home_fanmade_notice"))}</p>`;
  d.appendChild(hero);

  const grid = document.createElement("div");
  grid.className = "home-cards";

  function card(klass, icon, heading, txt, goto) {
    const el = document.createElement("article");
    el.className = `home-card ${klass}`.trim();
    const iconEl = document.createElement("div");
    iconEl.className = "home-card-icon";
    iconEl.setAttribute("aria-hidden", "true");
    iconEl.textContent = icon;
    const h3 = document.createElement("h3");
    h3.textContent = heading;
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = txt;
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = t(lang, "main.open");
    b.onclick = () => navigate(goto);
    el.appendChild(iconEl);
    el.appendChild(h3);
    el.appendChild(p);
    el.appendChild(b);
    grid.appendChild(el);
  }

  card("calc", "∑", t(lang, "nav.calc"), t(lang, "main.calc_desc"), "#/calc");
  card("trade", "⇄", t(lang, "nav.trade"), t(lang, "main.trade_desc"), "#/trade");
  card("values", "▦", t(lang, "nav.values"), t(lang, "main.values_desc"), "#/values");
  card(
    "predictions",
    "◈",
    t(lang, "nav.predictions"),
    t(lang, "main.predictions_desc"),
    "#/predictions",
  );
  if (testerAccessAllowed()) {
    card("tester", "⚙", t(lang, "nav.tester"), t(lang, "main.tester_desc"), "#/tester");
  }

  d.appendChild(grid);

  const foot = document.createElement("footer");
  foot.className = "home-foot";
  const credit = document.createElement("p");
  credit.className = "home-foot-credit muted";
  credit.append(
    document.createTextNode(`${t(lang, "main.list_values_thanks")} `),
  );
  const listLink = document.createElement("a");
  listLink.href = OFFICIAL_VALUE_LIST_URL;
  listLink.target = "_blank";
  listLink.rel = "noopener noreferrer";
  listLink.textContent = t(lang, "main.official_list_link");
  credit.appendChild(listLink);
  foot.appendChild(credit);
  const links = document.createElement("p");
  links.className = "home-foot-links muted";
  const creditsA = document.createElement("a");
  creditsA.href = "#/credits";
  creditsA.textContent = t(lang, "nav.credits");
  links.appendChild(creditsA);
  foot.appendChild(links);
  d.appendChild(foot);
  return d;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
}

function scannerResetNoticeError() {
  scannerTesterError = "";
  scannerTesterNotice = "";
}


function buildScannerView() {
  const wrap = document.createElement("div");
  wrap.className = "view-scanner";
  const bg = document.createElement("div");
  bg.className = "scanner-bg";
  bg.setAttribute("aria-hidden", "true");
  bg.innerHTML = `
    <div class="scanner-grid"></div>
    <div class="scanner-stripes"></div>`;

  const crane = document.createElement("div");
  crane.className = "scanner-crane-wrap";
  crane.setAttribute("aria-hidden", "true");
  crane.innerHTML = `
    <svg class="scanner-crane" viewBox="0 0 200 220" preserveAspectRatio="xMidYMax meet" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="sc-mast" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#6b7280"/>
          <stop offset="100%" stop-color="#3d4454"/>
        </linearGradient>
        <linearGradient id="sc-jib" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="#fcd34d"/>
          <stop offset="100%" stop-color="#b45309"/>
        </linearGradient>
      </defs>
      <rect x="68" y="178" width="64" height="14" rx="3" fill="#1f2937"/>
      <rect x="90" y="32" width="20" height="150" rx="3" fill="url(#sc-mast)"/>
      <path d="M 110 40 L 178 54 L 178 66 L 110 48 Z" fill="url(#sc-jib)"/>
      <line x1="172" y1="66" x2="152" y2="118" stroke="#94a3b8" stroke-width="2" stroke-linecap="round"/>
      <rect x="136" y="118" width="28" height="20" rx="3" fill="#4b5563" stroke="#f59e0b" stroke-width="1.5"/>
      <circle cx="178" cy="58" r="5" fill="#fbbf24"/>
      <rect x="78" y="168" width="44" height="12" rx="2" fill="#374151" stroke="rgba(245,158,11,0.5)" stroke-width="1"/>
    </svg>`;

  const card = document.createElement("div");
  card.className = "scanner-card";
  card.innerHTML = `
    <p class="scanner-kicker">${escapeHtml(t(lang, "scanner.kicker"))}</p>
    <h2 class="scanner-title">${escapeHtml(t(lang, "scanner.title"))}</h2>
    <p class="scanner-coming">${escapeHtml(t(lang, "scanner.coming"))}</p>
    <p class="scanner-wip">${escapeHtml(t(lang, "scanner.wip"))}</p>
    <p class="scanner-countdown-target muted">${escapeHtml(t(lang, "scanner.countdown_target"))}</p>
    <p class="scanner-countdown-head">${escapeHtml(t(lang, "scanner.countdown_heading"))}</p>
    <div class="scanner-countdown" data-scanner-countdown>
      <div class="scanner-cd-cell"><span class="scanner-cd-val" data-cd-d>0</span><span class="scanner-cd-lbl">${escapeHtml(t(lang, "scanner.cd_days"))}</span></div>
      <div class="scanner-cd-cell"><span class="scanner-cd-val" data-cd-h>00</span><span class="scanner-cd-lbl">${escapeHtml(t(lang, "scanner.cd_hours"))}</span></div>
      <div class="scanner-cd-cell"><span class="scanner-cd-val" data-cd-m>00</span><span class="scanner-cd-lbl">${escapeHtml(t(lang, "scanner.cd_minutes"))}</span></div>
      <div class="scanner-cd-cell"><span class="scanner-cd-val" data-cd-s>00</span><span class="scanner-cd-lbl">${escapeHtml(t(lang, "scanner.cd_seconds"))}</span></div>
    </div>
    <div class="scanner-blink" aria-hidden="true">
      <span class="scanner-blink-dot"></span>
      <span>${escapeHtml(t(lang, "scanner.live_build"))}</span>
    </div>`;

  wrap.appendChild(bg);
  wrap.appendChild(crane);
  wrap.appendChild(card);

  updateScannerCountdown(wrap);
  scannerCountdownTimer = setInterval(() => updateScannerCountdown(wrap), 1000);
  return wrap;
}

function buildTesterView() {
  const wrap = document.createElement("div");
  wrap.className = "view-scanner";
  const card = document.createElement("div");
  card.className = "scanner-card scanner-card--tester";
  card.innerHTML = `
    <p class="scanner-kicker">${escapeHtml(t(lang, "scanner.kicker"))}</p>
    <h2 class="scanner-title">${escapeHtml(t(lang, "scanner.tester_title"))}</h2>
    <p class="scanner-wip">${escapeHtml(t(lang, "scanner.tester_desc"))}</p>`;

  if (!testerAccessAllowed()) {
    const msg = document.createElement("p");
    msg.className = "scanner-msg scanner-msg--error";
    msg.textContent =
      testerIpStatus === "pending"
        ? t(lang, "scanner.ip_checking")
        : t(lang, "scanner.ip_denied");
    card.appendChild(msg);
    wrap.appendChild(card);
    return wrap;
  }

  const drop = document.createElement("div");
  drop.className = "scanner-dropzone";
  drop.tabIndex = 0;
  drop.textContent = t(lang, "scanner.drop_hint");
  drop.addEventListener("paste", (ev) => {
    const items = ev.clipboardData?.items || [];
    for (const item of items) {
      if (!item.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (!file) continue;
      const reader = new FileReader();
      reader.onload = () => {
        scannerTesterImageDataUrl = String(reader.result || "");
        scannerTesterNotice = t(lang, "scanner.source_loaded");
        scannerTesterMatches = [];
        scannerTesterTop5 = [];
        renderApp();
      };
      reader.readAsDataURL(file);
      ev.preventDefault();
      return;
    }
  });

  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.addEventListener("change", () => {
    const f = input.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      scannerTesterImageDataUrl = String(reader.result || "");
      scannerTesterNotice = t(lang, "scanner.source_loaded");
      scannerTesterMatches = [];
      renderApp();
    };
    reader.readAsDataURL(f);
  });

  const btnRow = document.createElement("div");
  btnRow.className = "scanner-actions";
  const analyzeBtn = document.createElement("button");
  analyzeBtn.type = "button";
  analyzeBtn.className = "scanner-btn scanner-btn--primary";
  analyzeBtn.disabled = scannerTesterAnalyzing;
  analyzeBtn.textContent = scannerTesterAnalyzing
    ? t(lang, "scanner.analyzing")
    : t(lang, "scanner.analyze");
  analyzeBtn.onclick = async () => {
    if (!scannerTesterImageDataUrl) {
      scannerTesterError = t(lang, "scanner.no_image");
      scannerTesterNotice = "";
      renderApp();
      return;
    }
    scannerResetNoticeError();
    scannerTesterAnalyzing = true;
    renderApp();
    try {
      const result = await compareImageWithUnits(scannerTesterImageDataUrl, units, {
        topN: 5,
        resolveAssetUrl: assetUrl,
      });

      scannerTesterTop5 = result.top5;
      scannerTesterMatches = result.detections.map((row) => ({
        unit: row.unit,
        count: row.count,
        vote: row.vote,
        bestSimilarity: row.bestSimilarity,
        confidencePercent: row.confidencePercent,
      }));

      if (!scannerTesterTop5.length && !scannerTesterMatches.length) {
        scannerTesterNotice = t(lang, "scanner.no_matches");
      } else {
        scannerTesterNotice = "";
      }
      } catch (e) {
        console.error("Error en el scanner:", e);
        scannerTesterError = t(lang, "scanner.error") + (e?.message || String(e));
      } finally {
        scannerTesterAnalyzing = false;
        renderApp();
      }
    };
  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "scanner-btn";
  clearBtn.textContent = t(lang, "scanner.clear");
  clearBtn.onclick = () => {
    scannerTesterImageDataUrl = "";
    scannerTesterMatches = [];
    scannerTesterTop5 = [];
    scannerResetNoticeError();
    renderApp();
  };
  btnRow.appendChild(analyzeBtn);
  btnRow.appendChild(clearBtn);

  card.appendChild(input);
  card.appendChild(drop);
  card.appendChild(btnRow);

  if (scannerTesterImageDataUrl) {
    const prev = document.createElement("img");
    prev.className = "scanner-preview";
    prev.src = scannerTesterImageDataUrl;
    prev.alt = "source";
    card.appendChild(prev);
  }

  if (scannerTesterError) {
    const err = document.createElement("p");
    err.className = "scanner-msg scanner-msg--error";
    err.textContent = scannerTesterError;
    card.appendChild(err);
  } else if (scannerTesterNotice) {
    const note = document.createElement("p");
    note.className = "scanner-msg";
    note.textContent = scannerTesterNotice;
    card.appendChild(note);
  }

  if (scannerTesterTop5.length) {
    const topTitle = document.createElement("h3");
    topTitle.className = "scanner-results-title";
    topTitle.textContent = t(lang, "scanner.top5_title");
    card.appendChild(topTitle);

    const topList = document.createElement("ol");
    topList.className = "visual-top5";
    for (const row of scannerTesterTop5) {
      const li = document.createElement("li");
      li.className = "visual-top5-item";
      const pct = Number(row.confidencePercent) || 0;
      const thumb = row.unit?.imagen
        ? `<img class="visual-top5-thumb" src="${escapeHtml(assetUrl(row.unit.imagen))}" alt="" loading="lazy" />`
        : `<span class="visual-top5-thumb visual-top5-thumb--empty"></span>`;
      li.innerHTML = `
        <span class="visual-top5-rank">${row.rank}</span>
        ${thumb}
        <div class="visual-top5-meta">
          <span class="visual-top5-name">${escapeHtml(unitDisplayName(row.unit))}</span>
          <div class="visual-top5-bar"><span class="visual-top5-bar-fill" style="width:${pct}%"></span></div>
        </div>
        <span class="visual-top5-pct">${pct.toFixed(1)}%</span>`;
      topList.appendChild(li);
    }
    card.appendChild(topList);
  }

    if (scannerTesterMatches.length) {
    const title = document.createElement("h3");
    title.className = "scanner-results-title";
    title.textContent = t(lang, "scanner.results_title");
    card.appendChild(title);

    const list = document.createElement("div");
    list.className = "scanner-results";
    let total = 0;
    for (const row of scannerTesterMatches) {
      total += (Number(row.unit.valor) || 0) * row.count;
      const item = document.createElement("div");
      item.className = "scanner-result-item";
      const nm = unitDisplayName(row.unit);
      item.innerHTML = `
        <span class="name">${escapeHtml(nm)} x${row.count}</span>
        <span class="sim">${(Number(row.confidencePercent) || 0).toFixed(1)}% · V${row.vote || 1}</span>
        <span class="val">${Number(row.unit.valor) || 0}</span>
      `;
      list.appendChild(item);
    }
    card.appendChild(list);
    const totalEl = document.createElement("p");
    totalEl.className = "scanner-total";
    totalEl.textContent = `${t(lang, "scanner.total")}: ${total}`;
    card.appendChild(totalEl);
  }

  const correctionPanel = document.createElement("div");
  correctionPanel.id = "correction-panel";
  correctionPanel.className = "correction-panel";
  correctionPanel.setAttribute("aria-hidden", scannerTesterMatches.length ? "false" : "true");
  correctionPanel.innerHTML = `
    <div class="correction-panel-head">
      <p>Corrección de resultados</p>
    </div>
    <div class="correction-panel-form">
      <label>
        Si ves
        <select data-correction-incorrect></select>
      </label>
      <label>
        En realidad es
        <select data-correction-correct></select>
      </label>
      <button type="button" class="scanner-btn scanner-btn--primary">Guardar corrección</button>
      <p class="correction-panel-note"></p>
    </div>
  `;

  const incorrectSelect = correctionPanel.querySelector("[data-correction-incorrect]");
  const correctSelect = correctionPanel.querySelector("[data-correction-correct]");
  const correctionNote = correctionPanel.querySelector(".correction-panel-note");
  const saveCorrectionButton = correctionPanel.querySelector("button");

  if (incorrectSelect && correctSelect) {
    const autoItems = scannerTesterMatches.map((row) =>
      unitDisplayName(row.unit) || String(row.unit?.nombre || row.unit?.nombre_en || "")
    );
    const uniqueItems = [...new Set(autoItems.filter(Boolean))];
    uniqueItems.forEach((name) => {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      incorrectSelect.appendChild(option);
    });

    const sortedUnits = [...units].sort((a, b) => {
      const aName = unitDisplayName(a).toLowerCase();
      const bName = unitDisplayName(b).toLowerCase();
      return aName.localeCompare(bName);
    });
    sortedUnits.forEach((unit) => {
      const option = document.createElement("option");
      option.value = unit.nombre;
      option.textContent = unitDisplayName(unit);
      correctSelect.appendChild(option);
    });
  }

  if (saveCorrectionButton) {
    saveCorrectionButton.onclick = () => {
      const incorrect = incorrectSelect?.value;
      const correct = correctSelect?.value;
      if (!incorrect || !correct) {
        if (correctionNote) correctionNote.textContent = "Selecciona una unidad errónea y otra correcta.";
        return;
      }
      saveCorrection(incorrect, correct);
      if (correctionNote) {
        correctionNote.textContent = `Guardado: Si ves [${incorrect}], en realidad es [${correct}].`;
      }
    };
  }

  card.appendChild(correctionPanel);
  wrap.appendChild(card);

  return wrap;
}

function buildValuesUnitCell(u, sticky = false) {
  const cell = document.createElement("td");
  cell.className = sticky
    ? "values-sticky-col values-cell-unit"
    : "values-cell-unit";
  if (u.imagen) {
    const img = document.createElement("img");
    img.className = "values-unit-thumb";
    img.src = assetUrl(u.imagen);
    img.alt = "";
    cell.appendChild(img);
  }
  const span = document.createElement("span");
  span.className = "values-cell-name";
  span.textContent = unitDisplayName(u);
  cell.appendChild(span);
  return cell;
}

function buildValuesVotePillsCell(u) {
  const td = document.createElement("td");
  td.className = "values-cell-votes";
  const wrap = document.createElement("div");
  wrap.className = "values-vote-pills";
  const baseVal = Number(u.valor) || 0;

  for (const entry of uniqueVoteEntriesForUnit(u)) {
    const { value: v, voteNums } = entry;
    const primaryVn = voteNums[0];
    const labels = voteNums.map((vn) => voteDisplayLabel(lang, vn));
    const pill = document.createElement("span");
    pill.className = [
      "values-vote-pill",
      v !== baseVal ? "values-vote-pill--diff" : "",
      voteNums.some((vn) => ESSENTIAL_VOTE_NUMS.includes(vn))
        ? "values-vote-pill--essential"
        : "",
      voteNums.length > 1 ? "values-vote-pill--multi" : "",
    ]
      .filter(Boolean)
      .join(" ");
    pill.title = labels.join(" · ");

    const img = document.createElement("img");
    img.className = "vote-icon";
    img.alt =
      voteNums.length > 1
        ? t(lang, "values.vote_incompatibles")
        : labels[0];
    setVoteIconImg(img, voteNums);

    const lbl = document.createElement("span");
    lbl.className = "values-vote-pill-label";
    lbl.textContent =
      voteNums.length > 1
        ? t(lang, "values.vote_incompatibles")
        : labels[0];

    const val = document.createElement("b");
    val.textContent = String(v);

    pill.appendChild(img);
    pill.appendChild(lbl);
    pill.appendChild(val);
    wrap.appendChild(pill);
  }

  td.appendChild(wrap);
  return td;
}

function buildValuesView() {
  const q = lastSearchValues;
  const wrap = document.createElement("div");
  wrap.className = "view-values";

  wrap.appendChild(buildPageHeader("values.title", "values.subtitle"));

  const tb = document.createElement("div");
  tb.className = "toolbar";
  const inp = document.createElement("input");
  inp.type = "text";
  inp.setAttribute("data-td-search", "values");
  inp.placeholder = t(lang, "values.search");
  inp.value = q;
  inp.autocomplete = "off";
  inp.spellcheck = false;
  inp.inputMode = "search";
  inp.addEventListener("input", () => {
    lastSearchValues = inp.value;
    pendingToolbarFocusRoute = "values";
    renderApp();
  });
  tb.appendChild(inp);
  wrap.appendChild(tb);
  wrap.appendChild(buildRarityFilterBar("values"));

  const filtered = [...getFilteredUnits(q, valuesRarityFilter)].sort(compareUnits);

  const tableSection = document.createElement("section");
  tableSection.className = "values-section";
  const tableHint = document.createElement("p");
  tableHint.className = "values-section-hint muted";
  tableHint.textContent = t(lang, "values.votes_hint");
  tableSection.appendChild(tableHint);

  if (!filtered.length) {
    const empty = document.createElement("p");
    empty.className = "values-empty muted";
    empty.textContent = t(lang, "values.no_results");
    tableSection.appendChild(empty);
  } else {
    const countNote = document.createElement("p");
    countNote.className = "values-count-note muted";
    countNote.textContent = t(lang, "values.showing_count", {
      shown: filtered.length,
      total: units.length,
    });
    tableSection.appendChild(countNote);

    const votesWrap = document.createElement("div");
    votesWrap.className = "values-table-wrap values-table-wrap--wide";
    const votesTable = document.createElement("table");
    votesTable.className = "values-table values-table--votes values-table--votes-compact";
    const voteHead = document.createElement("thead");
    const headRow = document.createElement("tr");
    const unitTh = document.createElement("th");
    unitTh.className = "values-sticky-col";
    unitTh.textContent = t(lang, "values.col_unit");
    headRow.appendChild(unitTh);
    for (const key of ["col_base", "col_demand", "col_stability", "col_votes"]) {
      const th = document.createElement("th");
      th.className =
        key === "col_votes"
          ? "values-votes-col-head"
          : key === "col_base"
            ? "values-base-head"
            : "values-demand-head";
      th.textContent = t(lang, `values.${key}`);
      headRow.appendChild(th);
    }
    voteHead.appendChild(headRow);
    votesTable.appendChild(voteHead);

    const voteBody = document.createElement("tbody");
    for (const u of filtered) {
      const tr = document.createElement("tr");
      tr.className = cardRarityClass(u.rareza);
      tr.appendChild(buildValuesUnitCell(u, true));
      tr.appendChild(buildValuesBaseValueCell(u));
      tr.appendChild(buildValuesDemandCell(u));
      tr.appendChild(buildValuesStabilityCell(u));
      tr.appendChild(buildValuesVotePillsCell(u));
      voteBody.appendChild(tr);
    }
    votesTable.appendChild(voteBody);
    votesWrap.appendChild(votesTable);
    tableSection.appendChild(votesWrap);
  }
  wrap.appendChild(tableSection);

  return wrap;
}

function predictionTrendLabel(trend) {
  const keys = {
    up: "predictions.trend_up",
    down: "predictions.trend_down",
    stable: "predictions.trend_stable",
    forecast_up: "predictions.trend_forecast_up",
    forecast_down: "predictions.trend_forecast_down",
  };
  return t(lang, keys[trend] || keys.stable);
}

function buildPredictionSparkline(points) {
  const width = 112;
  const height = 40;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("class", "pred-sparkline");
  if (!points.length) return svg;

  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const coords = points.map((v, i) => {
    const x = (i / Math.max(1, points.length - 1)) * width;
    const y = height - ((v - min) / range) * (height - 8) - 4;
    return { x, y, v };
  });

  const trend = points[points.length - 1] >= points[0] ? "up" : "down";
  svg.classList.add(`pred-sparkline--${trend}`);
  svg.title = points.map((v, i) => `#${i + 1}: ${v}`).join(" → ");

  const polyStr = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
  const areaStr = `0,${height} ${polyStr} ${width},${height}`;

  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  const grad = document.createElementNS("http://www.w3.org/2000/svg", "linearGradient");
  grad.setAttribute("id", `pred-spark-grad-${trend}-${Math.random().toString(36).slice(2, 7)}`);
  grad.setAttribute("x1", "0");
  grad.setAttribute("y1", "0");
  grad.setAttribute("x2", "0");
  grad.setAttribute("y2", "1");
  const stopA = document.createElementNS("http://www.w3.org/2000/svg", "stop");
  stopA.setAttribute("offset", "0%");
  stopA.setAttribute(
    "stop-color",
    trend === "up" ? "rgba(134,239,172,0.35)" : "rgba(252,165,165,0.35)",
  );
  const stopB = document.createElementNS("http://www.w3.org/2000/svg", "stop");
  stopB.setAttribute("offset", "100%");
  stopB.setAttribute("stop-color", "rgba(0,0,0,0)");
  grad.appendChild(stopA);
  grad.appendChild(stopB);
  defs.appendChild(grad);
  svg.appendChild(defs);

  const area = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  area.setAttribute("points", areaStr);
  area.setAttribute("fill", `url(#${grad.id})`);
  svg.appendChild(area);

  const poly = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  poly.setAttribute("points", polyStr);
  poly.setAttribute("fill", "none");
  poly.setAttribute("stroke-width", "2.2");
  poly.setAttribute("stroke-linecap", "round");
  poly.setAttribute("stroke-linejoin", "round");
  svg.appendChild(poly);

  const last = coords[coords.length - 1];
  const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  dot.setAttribute("cx", String(last.x));
  dot.setAttribute("cy", String(last.y));
  dot.setAttribute("r", "3.2");
  dot.classList.add("pred-sparkline-dot");
  svg.appendChild(dot);

  return svg;
}

function buildPredictionTrendPill(trend, delta, prefix = "") {
  const pill = document.createElement("span");
  pill.className = `pred-trend pred-trend--${trend}`;
  const arrow =
    trend === "up" || trend === "forecast_up"
      ? "↑"
      : trend === "down" || trend === "forecast_down"
        ? "↓"
        : "→";
  const deltaTxt = delta !== 0 ? ` ${delta > 0 ? "+" : ""}${delta}` : "";
  pill.textContent = `${prefix}${arrow} ${predictionTrendLabel(trend)}${deltaTxt}`;
  return pill;
}

function buildPredictionVoteGroupPill(group) {
  const pill = document.createElement("span");
  pill.className = [
    "pred-trend",
    "pred-vote-group",
    `pred-trend--${group.trend}`,
    group.isIncompatible ? "pred-vote-group--incompatible" : "",
  ]
    .filter(Boolean)
    .join(" ");

  if (group.isIncompatible) {
    const img = document.createElement("img");
    img.className = "vote-icon vote-icon--incompatible";
    img.alt = t(lang, "values.vote_incompatibles");
    setVoteIconImg(img, group.voteNums);
    pill.appendChild(img);
  }

  const label = group.isIncompatible
    ? t(lang, "values.vote_incompatibles")
    : voteDisplayLabel(lang, group.voteNums[0]);
  const deltaTxt =
    group.delta !== 0 ? ` (${group.delta > 0 ? "+" : ""}${group.delta})` : "";
  const txt = document.createElement("span");
  txt.textContent = `${label}: ${group.current}${deltaTxt}`;
  pill.appendChild(txt);
  return pill;
}

function matchesPredictionFilter(row) {
  const t0 = row.base.trend;
  if (predictionsFilter === "all") {
    // pass trend filter
  } else if (predictionsFilter === "up") {
    if (t0 !== "up" && t0 !== "forecast_up") return false;
  } else if (predictionsFilter === "down") {
    if (t0 !== "down" && t0 !== "forecast_down") return false;
  } else if (t0 !== "stable") {
    return false;
  }
  if (predictionsRarityFilter !== "all") {
    if (normalizeRarity(row.unit.rareza) !== predictionsRarityFilter) return false;
  }
  return true;
}

function buildPredictionsRarityFilterBar() {
  const current = predictionsRarityFilter;
  const bar = document.createElement("div");
  bar.className = "rarity-filter-bar pred-rarity-filter";

  const lbl = document.createElement("span");
  lbl.className = "rarity-filter-label";
  lbl.textContent = t(lang, "filter.rarity_label");

  const chips = document.createElement("div");
  chips.className = "rarity-filter-chips";

  const allBtn = document.createElement("button");
  allBtn.type = "button";
  allBtn.className = `rarity-chip rarity-chip--all${current === "all" ? " active" : ""}`;
  allBtn.textContent = t(lang, "filter.all");
  allBtn.onclick = () => {
    predictionsRarityFilter = "all";
    localStorage.setItem("tdhub_pred_rarity", "all");
    renderApp();
  };
  chips.appendChild(allBtn);

  for (const id of RARITY_IDS_DESC) {
    const btn = document.createElement("button");
    btn.type = "button";
    const cls = cardRarityClass(id);
    btn.className = `rarity-chip ${cls}${current === id ? " active" : ""}`.trim();
    btn.textContent = rarityLabel(lang, id);
    btn.onclick = () => {
      predictionsRarityFilter = id;
      localStorage.setItem("tdhub_pred_rarity", id);
      renderApp();
    };
    chips.appendChild(btn);
  }

  bar.appendChild(lbl);
  bar.appendChild(chips);
  return bar;
}

function buildPredictionDonut(summary) {
  const total = Math.max(1, summary.total);
  const upPct = (summary.up / total) * 100;
  const stablePct = (summary.stable / total) * 100;
  const downPct = (summary.down / total) * 100;
  const upEnd = upPct;
  const stableEnd = upEnd + stablePct;

  const wrap = document.createElement("div");
  wrap.className = "pred-donut-panel";

  const ring = document.createElement("div");
  ring.className = "pred-donut";
  ring.style.background = `conic-gradient(
    #86efac 0% ${upEnd}%,
    #fde047 ${upEnd}% ${stableEnd}%,
    #fca5a5 ${stableEnd}% 100%
  )`;
  ring.setAttribute("role", "img");
  ring.setAttribute(
    "aria-label",
    `${summary.up} up, ${summary.stable} stable, ${summary.down} down`,
  );

  const hole = document.createElement("div");
  hole.className = "pred-donut-hole";
  const holeNum = document.createElement("span");
  holeNum.className = "pred-donut-total";
  holeNum.textContent = String(summary.total);
  const holeLbl = document.createElement("span");
  holeLbl.className = "pred-donut-lbl";
  holeLbl.textContent = t(lang, "predictions.chart_units");
  hole.appendChild(holeNum);
  hole.appendChild(holeLbl);
  ring.appendChild(hole);
  wrap.appendChild(ring);

  const legend = document.createElement("ul");
  legend.className = "pred-donut-legend";
  for (const [key, count, cls, labelKey] of [
    ["up", summary.up, "pred-legend--up", "predictions.summary_up"],
    ["stable", summary.stable, "pred-legend--stable", "predictions.summary_stable"],
    ["down", summary.down, "pred-legend--down", "predictions.summary_down"],
  ]) {
    const pct = Math.round((count / total) * 100);
    const li = document.createElement("li");
    li.className = `pred-legend-item ${cls}`;
    li.innerHTML = `
      <span class="pred-legend-dot"></span>
      <span class="pred-legend-text">${escapeHtml(t(lang, labelKey))}</span>
      <span class="pred-legend-val">${count} <em>(${pct}%)</em></span>`;
    li.title = `${count} ${key}`;
    legend.appendChild(li);
  }
  wrap.appendChild(legend);
  return wrap;
}

function buildRarityTrendChart(breakdown) {
  const panel = document.createElement("div");
  panel.className = "pred-rarity-chart";

  const head = document.createElement("div");
  head.className = "pred-rarity-chart-head";
  head.innerHTML = `<span>${escapeHtml(t(lang, "predictions.chart_by_rarity"))}</span>`;
  panel.appendChild(head);

  const order = [
    ...RARITY_IDS_DESC.filter((id) => breakdown[id]?.total),
    ...Object.keys(breakdown).filter((id) => !RARITY_IDS_DESC.includes(id)),
  ];

  if (!order.length) {
    const empty = document.createElement("p");
    empty.className = "pred-rarity-chart-empty muted";
    empty.textContent = t(lang, "predictions.chart_no_data");
    panel.appendChild(empty);
    return panel;
  }

  for (const rarityId of order) {
    const stats = breakdown[rarityId];
    if (!stats?.total) continue;

    const row = document.createElement("div");
    row.className = `pred-rarity-chart-row ${cardRarityClass(rarityId)}`;

    const label = document.createElement("span");
    label.className = "pred-rarity-chart-label";
    label.textContent = rarityLabel(lang, rarityId);

    const bar = document.createElement("div");
    bar.className = "pred-rarity-chart-bar";
    bar.setAttribute("role", "img");
    bar.title = `${stats.up}↑ ${stats.stable}→ ${stats.down}↓`;

    for (const [count, cls] of [
      [stats.up, "pred-rarity-chart-seg--up"],
      [stats.stable, "pred-rarity-chart-seg--stable"],
      [stats.down, "pred-rarity-chart-seg--down"],
    ]) {
      if (!count) continue;
      const seg = document.createElement("span");
      seg.className = `pred-rarity-chart-seg ${cls}`;
      seg.style.flex = String(Math.max(count, 1));
      bar.appendChild(seg);
    }

    const countEl = document.createElement("span");
    countEl.className = "pred-rarity-chart-count";
    countEl.textContent = String(stats.total);

    row.appendChild(label);
    row.appendChild(bar);
    row.appendChild(countEl);
    panel.appendChild(row);
  }

  return panel;
}

function buildPredictionScoreBadge(score) {
  const badge = document.createElement("span");
  badge.className = "pred-score-badge";
  if (score > 0) badge.classList.add("pred-score-badge--pos");
  else if (score < 0) badge.classList.add("pred-score-badge--neg");
  else badge.classList.add("pred-score-badge--neutral");
  badge.title = t(lang, "predictions.score_hint");
  badge.textContent = score > 0 ? `+${score}` : String(score);
  return badge;
}

function predictionTrendAccentClass(trend) {
  if (trend === "up" || trend === "forecast_up") return "pred-card--up";
  if (trend === "down" || trend === "forecast_down") return "pred-card--down";
  return "pred-card--stable";
}

function buildPredictionSpotlight(rows) {
  const panel = document.createElement("section");
  panel.className = "pred-spotlight";

  const upRows = rows
    .filter((r) => r.base.trend === "up" || r.base.trend === "forecast_up")
    .slice(0, 3);
  const downRows = rows
    .filter((r) => r.base.trend === "down" || r.base.trend === "forecast_down")
    .slice(0, 3);

  if (!upRows.length && !downRows.length) return panel;

  const title = document.createElement("h3");
  title.className = "pred-spotlight-title";
  title.textContent = t(lang, "predictions.spotlight_title");
  panel.appendChild(title);

  const grid = document.createElement("div");
  grid.className = "pred-spotlight-grid";

  function miniColumn(kind, labelKey, items) {
    if (!items.length) return;
    const col = document.createElement("div");
    col.className = `pred-spotlight-col pred-spotlight-col--${kind}`;
    const lbl = document.createElement("span");
    lbl.className = "pred-spotlight-col-label";
    lbl.textContent = t(lang, labelKey);
    col.appendChild(lbl);
    const list = document.createElement("ul");
    list.className = "pred-spotlight-list";
    for (const row of items) {
      const li = document.createElement("li");
      li.className = `pred-spotlight-item ${cardRarityClass(row.unit.rareza)}`.trim();
      if (row.unit.imagen) {
        const img = document.createElement("img");
        img.src = assetUrl(row.unit.imagen);
        img.alt = "";
        li.appendChild(img);
      }
      const meta = document.createElement("div");
      meta.className = "pred-spotlight-item-meta";
      const name = document.createElement("strong");
      name.textContent = unitDisplayName(row.unit);
      const delta = document.createElement("span");
      delta.className = "pred-spotlight-item-delta";
      const sign = row.base.delta > 0 ? "+" : "";
      delta.textContent = `${sign}${row.base.delta || "—"}`;
      meta.appendChild(name);
      meta.appendChild(delta);
      li.appendChild(meta);
      list.appendChild(li);
    }
    col.appendChild(list);
    grid.appendChild(col);
  }

  miniColumn("up", "predictions.spotlight_risers", upRows);
  miniColumn("down", "predictions.spotlight_fallers", downRows);
  panel.appendChild(grid);
  return panel;
}

function buildPredictionCard(row) {
  const card = document.createElement("article");
  card.className = [
    "pred-card",
    cardRarityClass(row.unit.rareza),
    predictionTrendAccentClass(row.base.trend),
  ]
    .filter(Boolean)
    .join(" ");

  const head = document.createElement("div");
  head.className = "pred-card-head";

  const identity = document.createElement("div");
  identity.className = "pred-card-identity";
  if (row.unit.imagen) {
    const face = document.createElement("div");
    face.className = "pred-card-face";
    const img = document.createElement("img");
    img.className = "pred-card-thumb";
    img.src = assetUrl(row.unit.imagen);
    img.alt = "";
    face.appendChild(img);
    identity.appendChild(face);
  }

  const info = document.createElement("div");
  info.className = "pred-card-info";
  const nameRow = document.createElement("div");
  nameRow.className = "pred-card-name-row";
  const name = document.createElement("span");
  name.className = "pred-card-name";
  name.textContent = unitDisplayName(row.unit);
  nameRow.appendChild(name);
  nameRow.appendChild(buildRarityBadge(row.unit.rareza));
  info.appendChild(nameRow);

  const metaRow = document.createElement("div");
  metaRow.className = "pred-card-meta-row";
  const val = document.createElement("span");
  val.className = "pred-card-val";
  val.innerHTML = `${escapeHtml(t(lang, "predictions.base_value"))}: <strong>${row.base.current}</strong>`;
  metaRow.appendChild(val);
  metaRow.appendChild(buildDemandScoreBadge(row.unit));
  info.appendChild(metaRow);
  identity.appendChild(info);
  head.appendChild(identity);

  const sparkWrap = document.createElement("div");
  sparkWrap.className = "pred-card-spark-wrap";
  sparkWrap.appendChild(buildPredictionScoreBadge(row.score));
  sparkWrap.appendChild(buildPredictionSparkline(row.sparkline));
  head.appendChild(sparkWrap);

  const trends = document.createElement("div");
  trends.className = "pred-card-trends";
  trends.appendChild(
    buildPredictionTrendPill(row.base.trend, row.base.delta, `${t(lang, "predictions.base_value")}: `),
  );
  const baseVal = Number(row.unit.valor) || 0;
  for (const group of row.voteGroups || []) {
    if (group.value === baseVal && group.trend === "stable" && group.delta === 0) {
      continue;
    }
    trends.appendChild(buildPredictionVoteGroupPill(group));
  }

  const tip = document.createElement("p");
  tip.className = "pred-card-tip muted";
  tip.textContent = t(lang, row.tipKey);

  card.appendChild(head);
  card.appendChild(trends);
  card.appendChild(tip);
  return card;
}

function groupPredictionRowsByRarity(filteredRows) {
  /** @type {Map<string, typeof filteredRows>} */
  const map = new Map();
  for (const row of filteredRows) {
    const key = normalizeRarity(row.unit.rareza) || "other";
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  const order = [
    ...RARITY_IDS_DESC.filter((id) => map.has(id)),
    ...[...map.keys()].filter((id) => !RARITY_IDS_DESC.includes(id)),
  ];
  return order.map((rarityId) => ({ rarityId, rows: map.get(rarityId) || [] }));
}

function buildPredictionsView() {
  const wrap = document.createElement("div");
  wrap.className = "view-predictions";

  wrap.appendChild(buildPageHeader("predictions.title", "predictions.subtitle"));

  const beta = document.createElement("div");
  beta.className = "pred-beta-banner";
  beta.innerHTML = `
    <span class="pred-beta-badge">${escapeHtml(t(lang, "predictions.beta_badge"))}</span>
    <p>${escapeHtml(t(lang, "predictions.beta_notice"))}</p>`;
  wrap.appendChild(beta);

  const rows = buildPredictions(units, vote_values, valueHistory);
  const summary = predictionSummary(rows);
  const rarityBreakdown = buildRarityBreakdown(rows);
  const snaps = historySnapshotCount();

  const analytics = document.createElement("div");
  analytics.className = "pred-analytics";

  const summaryBox = document.createElement("div");
  summaryBox.className = "pred-summary";
  summaryBox.innerHTML = `
    <div class="pred-summary-stat pred-summary-stat--up">
      <span class="pred-summary-num">${summary.up}</span>
      <span class="pred-summary-lbl">${escapeHtml(t(lang, "predictions.summary_up"))}</span>
    </div>
    <div class="pred-summary-stat pred-summary-stat--stable">
      <span class="pred-summary-num">${summary.stable}</span>
      <span class="pred-summary-lbl">${escapeHtml(t(lang, "predictions.summary_stable"))}</span>
    </div>
    <div class="pred-summary-stat pred-summary-stat--down">
      <span class="pred-summary-num">${summary.down}</span>
      <span class="pred-summary-lbl">${escapeHtml(t(lang, "predictions.summary_down"))}</span>
    </div>`;

  const charts = document.createElement("div");
  charts.className = "pred-charts";
  charts.appendChild(buildPredictionDonut(summary));
  charts.appendChild(buildRarityTrendChart(rarityBreakdown));

  analytics.appendChild(summaryBox);
  analytics.appendChild(charts);
  wrap.appendChild(analytics);

  const spotlight = buildPredictionSpotlight(rows);
  if (spotlight.childElementCount > 0) wrap.appendChild(spotlight);

  const meta = document.createElement("p");
  meta.className = "pred-meta muted";
  meta.textContent = t(lang, snaps >= 2 ? "predictions.history_ready" : "predictions.history_warming");
  wrap.appendChild(meta);

  const controls = document.createElement("div");
  controls.className = "pred-controls";

  const filterBar = document.createElement("div");
  filterBar.className = "pred-filter-bar";
  for (const [id, labelKey] of [
    ["all", "predictions.filter_all"],
    ["up", "predictions.filter_up"],
    ["down", "predictions.filter_down"],
    ["stable", "predictions.filter_stable"],
  ]) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className =
      predictionsFilter === id ? "pred-filter-btn active" : "pred-filter-btn";
    btn.textContent = t(lang, labelKey);
    btn.onclick = () => {
      predictionsFilter = id;
      localStorage.setItem("tdhub_pred_filter", id);
      renderApp();
    };
    filterBar.appendChild(btn);
  }
  controls.appendChild(filterBar);

  const sortRow = document.createElement("div");
  sortRow.className = "pred-sort-row";
  const sortLbl = document.createElement("label");
  sortLbl.className = "pred-sort-label";
  sortLbl.htmlFor = "pred-sort-select";
  sortLbl.textContent = t(lang, "predictions.sort_label");
  const sortSel = document.createElement("select");
  sortSel.id = "pred-sort-select";
  sortSel.className = "pred-sort-select";
  for (const [id, labelKey] of [
    ["score", "predictions.sort_score"],
    ["rarity", "predictions.sort_rarity"],
    ["delta", "predictions.sort_delta"],
    ["value", "predictions.sort_value"],
    ["name", "predictions.sort_name"],
  ]) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = t(lang, labelKey);
    opt.selected = predictionsSort === id;
    sortSel.appendChild(opt);
  }
  sortSel.onchange = () => {
    predictionsSort = /** @type {typeof predictionsSort} */ (sortSel.value);
    localStorage.setItem("tdhub_pred_sort", predictionsSort);
    renderApp();
  };
  sortRow.appendChild(sortLbl);
  sortRow.appendChild(sortSel);
  controls.appendChild(sortRow);
  controls.appendChild(buildPredictionsRarityFilterBar());
  wrap.appendChild(controls);

  const sorted = sortPredictionRows(rows, predictionsSort);
  const filtered = sorted.filter(matchesPredictionFilter);

  const resultMeta = document.createElement("p");
  resultMeta.className = "pred-result-meta muted";
  resultMeta.textContent = t(lang, "predictions.showing_count", {
    shown: String(filtered.length),
    total: String(rows.length),
  });
  wrap.appendChild(resultMeta);

  const listRoot = document.createElement("div");
  listRoot.className = "pred-list-root";

  if (!filtered.length) {
    const empty = document.createElement("p");
    empty.className = "pred-empty muted";
    empty.textContent = t(lang, "predictions.no_results");
    listRoot.appendChild(empty);
  } else if (predictionsSort === "rarity") {
    for (const { rarityId, rows: groupRows } of groupPredictionRowsByRarity(filtered)) {
      const section = document.createElement("section");
      section.className = `pred-rarity-section ${cardRarityClass(rarityId)}`;

      const secHead = document.createElement("header");
      secHead.className = "pred-rarity-section-head";
      secHead.appendChild(buildRarityBadge(rarityId));
      const secCount = document.createElement("span");
      secCount.className = "pred-rarity-section-count muted";
      secCount.textContent = t(lang, "predictions.section_count", {
        count: String(groupRows.length),
      });
      secHead.appendChild(secCount);
      section.appendChild(secHead);

      const list = document.createElement("div");
      list.className = "pred-list";
      for (const row of groupRows) list.appendChild(buildPredictionCard(row));
      section.appendChild(list);
      listRoot.appendChild(section);
    }
  } else {
    const list = document.createElement("div");
    list.className = "pred-list pred-list--grid";
    for (const row of filtered) list.appendChild(buildPredictionCard(row));
    listRoot.appendChild(list);
  }

  wrap.appendChild(listRoot);
  return wrap;
}

function buildCreditsView() {
  const stage = document.createElement("div");
  stage.className = "credits-stage view-credits";

  const aurora = document.createElement("div");
  aurora.className = "credits-aurora";
  aurora.setAttribute("aria-hidden", "true");
  const glowA = document.createElement("div");
  glowA.className = "credits-glow credits-glow--a";
  glowA.setAttribute("aria-hidden", "true");
  const glowB = document.createElement("div");
  glowB.className = "credits-glow credits-glow--b";
  glowB.setAttribute("aria-hidden", "true");
  const glowC = document.createElement("div");
  glowC.className = "credits-glow credits-glow--c";
  glowC.setAttribute("aria-hidden", "true");
  const spotlight = document.createElement("div");
  spotlight.className = "credits-spotlight";
  spotlight.setAttribute("aria-hidden", "true");
  const particles = document.createElement("div");
  particles.className = "credits-particles";
  particles.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 18; i++) {
    const p = document.createElement("span");
    p.className = "credits-particle";
    p.style.setProperty("--i", String(i));
    particles.appendChild(p);
  }
  const shine = document.createElement("div");
  shine.className = "credits-shine";
  shine.setAttribute("aria-hidden", "true");
  const floor = document.createElement("div");
  floor.className = "credits-floor";
  floor.setAttribute("aria-hidden", "true");

  stage.appendChild(aurora);
  stage.appendChild(glowA);
  stage.appendChild(glowB);
  stage.appendChild(glowC);
  stage.appendChild(spotlight);
  stage.appendChild(particles);
  stage.appendChild(shine);
  stage.appendChild(floor);

  const d = document.createElement("div");
  d.className = "credits-box";

  const header = document.createElement("header");
  header.className = "credits-header";
  const kicker = document.createElement("p");
  kicker.className = "credits-kicker";
  kicker.textContent = t(lang, "credits.kicker");
  const title = document.createElement("h2");
  title.className = "credits-title-main";
  title.textContent = t(lang, "credits.title");
  const intro = document.createElement("p");
  intro.className = "credits-intro muted";
  intro.textContent = t(lang, "credits.subtitle");
  const badge = document.createElement("span");
  badge.className = "credits-badge";
  badge.textContent = t(lang, "credits.badge");
  header.appendChild(kicker);
  header.appendChild(title);
  header.appendChild(intro);
  header.appendChild(badge);

  const version = document.createElement("span");
  version.className = "credits-version";
  version.textContent = t(lang, "credits.version");
  header.appendChild(version);

  const features = document.createElement("div");
  features.className = "credits-features";
  const featureItems = [
    { k: "credits.feature_calc", r: "#/calc" },
    { k: "credits.feature_trade", r: "#/trade" },
    { k: "credits.feature_values", r: "#/values" },
    { k: "credits.feature_predictions", r: "#/predictions" },
  ];
  featureItems.forEach((item, i) => {
    const chip = document.createElement("a");
    chip.className = "credits-feature-chip";
    chip.href = item.r;
    chip.style.setProperty("--chip-i", String(i));
    chip.textContent = t(lang, item.k);
    features.appendChild(chip);
  });
  header.appendChild(features);
  d.appendChild(header);

  const divider = document.createElement("div");
  divider.className = "credits-divider";
  divider.setAttribute("aria-hidden", "true");
  d.appendChild(divider);

  const grid = document.createElement("div");
  grid.className = "credits-grid";
  CREDITS_PROFILES.forEach((m, idx) => {
    const card = document.createElement("article");
    card.className = `credits-card credits-card--portrait ${m.accent}`;
    card.style.setProperty("--card-i", String(idx));

    const cardGlow = document.createElement("div");
    cardGlow.className = "credits-card-glow";
    cardGlow.setAttribute("aria-hidden", "true");

    const avatarFrame = document.createElement("div");
    avatarFrame.className = "credits-avatar-frame";

    const ringSpin = document.createElement("div");
    ringSpin.className = "credits-ring-spin";
    ringSpin.setAttribute("aria-hidden", "true");

    const ring = document.createElement("div");
    ring.className = "credits-card-ring";
    ring.setAttribute("aria-hidden", "true");

    const avatarWrap = document.createElement("div");
    avatarWrap.className = "credits-avatar";
    const avatarImg = document.createElement("img");
    avatarImg.src = assetUrl(m.avatar);
    avatarImg.alt = `${m.handle} avatar`;
    const avatarFallback = document.createElement("span");
    avatarFallback.textContent = m.initials;
    avatarImg.addEventListener("error", () => {
      avatarImg.style.display = "none";
      avatarFallback.style.display = "grid";
    });
    avatarWrap.appendChild(avatarImg);
    avatarWrap.appendChild(avatarFallback);

    avatarFrame.appendChild(ringSpin);
    avatarFrame.appendChild(ring);
    avatarFrame.appendChild(avatarWrap);

    const meta = document.createElement("div");
    meta.className = "credits-meta";
    const handle = document.createElement("h3");
    handle.textContent = m.handle;
    const role = document.createElement("p");
    role.className = "credits-role";
    role.textContent = t(lang, m.roleKey);
    meta.appendChild(handle);
    meta.appendChild(role);

    const actions = document.createElement("div");
    actions.className = "credits-actions";
    const dBtn = document.createElement("a");
    dBtn.href = m.discordUrl;
    dBtn.target = "_blank";
    dBtn.rel = "noopener noreferrer";
    dBtn.textContent = t(lang, "credits.open_discord");
    const rBtn = document.createElement("a");
    rBtn.href = m.robloxUrl;
    rBtn.target = "_blank";
    rBtn.rel = "noopener noreferrer";
    rBtn.textContent = t(lang, "credits.open_roblox");
    actions.appendChild(dBtn);
    actions.appendChild(rBtn);

    card.appendChild(cardGlow);
    card.appendChild(avatarFrame);
    card.appendChild(meta);
    card.appendChild(actions);
    grid.appendChild(card);
  });
  d.appendChild(grid);

  const thanks = document.createElement("section");
  thanks.className = "credits-thanks";
  const thanksTitle = document.createElement("h3");
  thanksTitle.className = "credits-thanks-title";
  thanksTitle.textContent = t(lang, "credits.thanks_title");
  thanks.appendChild(thanksTitle);

  const thanksList = document.createElement("ul");
  thanksList.className = "credits-thanks-list";
  const thanksItems = [
    { k: "credits.thanks_value_list", href: OFFICIAL_VALUE_LIST_URL, external: true },
    { k: "credits.thanks_community" },
    { k: "credits.thanks_roblox" },
  ];
  thanksItems.forEach((item) => {
    const li = document.createElement("li");
    if (item.href) {
      const a = document.createElement("a");
      a.href = item.href;
      a.textContent = t(lang, item.k);
      if (item.external) {
        a.target = "_blank";
        a.rel = "noopener noreferrer";
      }
      li.appendChild(a);
    } else {
      li.textContent = t(lang, item.k);
    }
    thanksList.appendChild(li);
  });
  thanks.appendChild(thanksList);
  d.appendChild(thanks);

  const foot = document.createElement("p");
  foot.className = "muted credits-foot";
  foot.textContent = t(lang, "credits.foot");
  d.appendChild(foot);
  stage.appendChild(d);
  return stage;
}

function currentRoute() {
  const h = (location.hash || "#/").replace(/^#/, "") || "/";
  if (h === "/" || h === "/home") return "home";
  if (h.startsWith("/calc")) return "calc";
  if (h.startsWith("/trade")) return "trade";
  if (h.startsWith("/values")) return "values";
  if (h.startsWith("/predictions")) return "predictions";
  if (h.startsWith("/scanner")) return "home";
  if (h.startsWith("/tester")) return "tester";
  if (h.startsWith("/credits")) return "credits";
  return "home";
}

function navigate(hash) {
  location.hash = hash;
}

function renderApp() {
  const root = document.getElementById("app");
  if (!root) return;
  root.style.overflow = "";
  rememberRouteScroll();

  clearScannerCountdown();
  root.innerHTML = "";

  const shell = document.createElement("div");
  const playEnter = appBootstrapped && !hasPlayedEnterAnim;
  shell.className = playEnter ? "app-shell app-shell--enter" : "app-shell";
  if (playEnter) hasPlayedEnterAnim = true;

  const side = document.createElement("aside");
  side.className = "sidebar";

  const brand = document.createElement("div");
  brand.className = "sidebar-brand";
  const title = document.createElement("h1");
  title.textContent = "SORCERER TD";
  const tagline = document.createElement("p");
  tagline.className = "sidebar-tagline";
  tagline.textContent = t(lang, "main.sidebar_tagline");
  brand.appendChild(title);
  brand.appendChild(tagline);
  side.appendChild(brand);

  const nav = [
    { r: "#/home", k: "nav.home", rr: "home" },
    { r: "#/calc", k: "nav.calc", rr: "calc" },
    { r: "#/trade", k: "nav.trade", rr: "trade" },
    { r: "#/values", k: "nav.values", rr: "values" },
    { r: "#/predictions", k: "nav.predictions", rr: "predictions" },
    ...(testerAccessAllowed()
      ? [{ r: "#/tester", k: "nav.tester", rr: "tester" }]
      : []),
    { r: "#/credits", k: "nav.credits", rr: "credits" },
  ];
  const cur = currentRoute();
  for (const { r, k, rr } of nav) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cur === rr ? "nav-btn active" : "nav-btn";
    b.textContent = t(lang, k);
    b.onclick = () => navigate(r);
    side.appendChild(b);
  }

  const langRow = document.createElement("div");
  langRow.className = "lang-row";
  const ba = document.createElement("button");
  ba.textContent = "ES";
  ba.className = lang === "es" ? "active" : "";
  ba.onclick = () => setLang("es");
  const be = document.createElement("button");
  be.textContent = "EN";
  be.className = lang === "en" ? "active" : "";
  be.onclick = () => setLang("en");
  langRow.appendChild(ba);
  langRow.appendChild(be);
  side.appendChild(langRow);

  const main = document.createElement("main");
  let route = currentRoute();
  main.className = [
    "content",
    playEnter ? "content--enter" : "",
    route === "home" ? "content--home" : "",
  ]
    .filter(Boolean)
    .join(" ");
  if (route === "tester" && !testerAccessAllowed()) {
    if (testerIpStatus === "pending") {
      main.appendChild(buildTesterView());
    } else {
      navigate("#/home");
      route = "home";
      main.appendChild(buildHomeView());
    }
  } else if (route === "home") main.appendChild(buildHomeView());
  else if (route === "calc") main.appendChild(buildCalcView());
  else if (route === "trade") main.appendChild(buildTradeView());
  else if (route === "values") main.appendChild(buildValuesView());
  else if (route === "predictions") main.appendChild(buildPredictionsView());
  else if (route === "tester") main.appendChild(buildTesterView());
  else main.appendChild(buildCreditsView());

  shell.appendChild(side);
  shell.appendChild(main);
  root.appendChild(shell);
  restoreRouteScroll(route, main);

  if (route === "calc") maybeRefocusToolbarSearch("calc");
  else if (route === "trade") maybeRefocusToolbarSearch("trade");
  else if (route === "values") maybeRefocusToolbarSearch("values");
}

function setLang(newLang) {
  lang = newLang;
  setCookie(LANG_COOKIE, newLang);
  if (voteDialogEl?.open && modalCtx.unit) {
    voteDialogEl.close();
    queueMicrotask(() => openVoteSheet(modalCtx.mode, modalCtx.unit, modalCtx.side));
  }
  renderApp();
}

async function bootstrap() {
  const root = document.getElementById("app");
  root.className = "app-loading";
  root.innerHTML = `<p class="muted app-loading-text">Cargando datos…</p>`;
  try {
    const loaded = await loadUnitsAndVotes();
    units = loaded.units;
    vote_values = loaded.vote_values;
  } catch (e) {
    root.className = "";
    root.style.overflowY = "auto";
    root.innerHTML = "";
    const b = document.createElement("div");
    b.style.padding = "24px";
    b.innerHTML =
      `<div class="error-banner">${escapeHtml(e?.message || String(e))}</div>
      <p class="muted">Crea el archivo <code>web/.env</code> con VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY (los mismos que en data/remote_config.json del escritorio).</p>`;
    root.appendChild(b);
    return;
  }

  syncTdMobileAttr();
  valueHistory = recordValueSnapshot(units, vote_values);
  root.className = "app-ready";
  appBootstrapped = true;
  playPageIntro();
  warmUnitTemplates(units, assetUrl).catch(() => {});
  renderApp();
  resolveTesterIpAccess().then(() => renderApp());

  window.addEventListener("hashchange", () => {
    renderApp();
    if (voteDialogEl?.open && modalCtx.unit) voteDialogEl.close();
  });
}

bootstrap();
