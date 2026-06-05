import { assetUrl } from "./assetUrl.js";
import { loadUnitsAndVotes } from "./supabase/loadData.js";
import {
  rarityRank,
  normalizeRarity,
  rarityLabel,
  RARITY_IDS_DESC,
} from "./rarity.js";
import { t } from "./strings.js";
import { GoogleGenerativeAI } from "@google/generative-ai";

/** Lista de valores oficial (Sorcerer TD Value list). */
const OFFICIAL_VALUE_LIST_URL =
  "https://docs.google.com/spreadsheets/d/1--hVDdfHVSGLI1MF_Cmo0Te1Ir71KUxqnaqRX_CRCyI/htmlview?gid=0&pru=AAABnNPEMFQ*iMq033usqNrkyrEjGY0jeQ#gid=0";

/** @typedef {{nombre:string,nombre_en:string,valor:number,imagen:string,rareza:string}} Unit */

/** @type {Unit[]} */
let units = [];
/** @type {Record<string, Record<string, number>>} */
let vote_values = {};

let lang =
  typeof localStorage !== "undefined" &&
  localStorage.getItem("tdhub_lang") === "en"
    ? "en"
    : "es";

const calcSelections = Object.create(null);
const calcLastVote = Object.create(null);

const tradeLeftCounts = Object.create(null);
const tradeRightCounts = Object.create(null);
const tradeLeftLast = Object.create(null);
const tradeRightLast = Object.create(null);

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

/** @type {"all" | string} */
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

const TESTER_ALLOWED_IPS = String(import.meta.env.VITE_TESTER_ALLOWED_IPS || "")
  .split(",")
  .map((ip) => ip.trim())
  .filter(Boolean);

let testerIpStatus = /** @type {"pending" | "allowed" | "denied"} */ ("pending");
let testerClientIp = "";
const SCANNER_VECTOR_SIZE = 40;
// Umbral ajustado: demasiada dureza => 0 detecciones.
// Se compensa con filtro por "gap" y supresión de solapamientos.
const SCANNER_MATCH_THRESHOLD = 0.70;
const p1 = "AIzaSyAvyTL"; 
const p2 = "nMFYN8E92ijisr"; 
const p3 = "5dDFpyQS__EmnA"; 
const GEMINI_KEY = p1 + p2 + p3;
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
];

let scannerTesterError = "";
let scannerTesterNotice = "";
let scannerTesterImageDataUrl = "";
let scannerTesterAnalyzing = false;
let scannerTesterMatches = [];
const CORRECTION_HISTORY_KEY = "td_correction_history";
const scannerTemplateCache = new Map();
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
  if (route !== "calc" && route !== "trade" && route !== "values" && route !== "tester")
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
  if (!TESTER_ALLOWED_IPS.length) return false;
  return testerIpStatus === "allowed";
}

async function resolveTesterIpAccess() {
  if (!TESTER_ALLOWED_IPS.length) {
    testerIpStatus = "denied";
    return;
  }
  testerIpStatus = "pending";
  try {
    const res = await fetch("https://api.ipify.org?format=json", {
      cache: "no-store",
    });
    if (!res.ok) throw new Error("ip fetch failed");
    const data = await res.json();
    testerClientIp = String(data?.ip || "").trim();
    testerIpStatus = TESTER_ALLOWED_IPS.includes(testerClientIp)
      ? "allowed"
      : "denied";
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

  for (let i = 1; i <= 13; i++) {
    const vk = `voto${i}`;
    const val = voteValueForUnit(u, vk);
    const row = document.createElement("div");
    row.className = "vote-line";

    const img = document.createElement("img");
    img.alt = vk;
    img.src = assetUrl(`assets/votos/voto${i}.png`);
    img.onerror = () => {
      img.replaceWith(document.createTextNode(`V${i}`));
    };

    const info = document.createElement("span");
    info.className = "val-info";
    info.textContent = `${t(lang, "trade.value")}: ${val}`;

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

  const invCap = document.createElement("div");
  invCap.className = "trade-inventory-caption muted";
  invCap.textContent = t(lang, "trade.inventory_caption");
  col.appendChild(invCap);
  col.appendChild(buildTradeInventory(sideName));

  return col;
}

function buildTradeView() {
  const q = lastSearchTrade;
  const wrap = document.createElement("div");
  wrap.className = "view-trade";

  wrap.appendChild(buildPageHeader("trade.title", "trade.subtitle"));

  const tb = document.createElement("div");
  tb.className = "toolbar";
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

  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "toolbar-btn-clear";
  clearBtn.textContent = t(lang, "trade.clear");
  clearBtn.onclick = () => {
    for (const k of Object.keys(tradeLeftCounts)) delete tradeLeftCounts[k];
    for (const k of Object.keys(tradeRightCounts)) delete tradeRightCounts[k];
    for (const k of Object.keys(tradeLeftLast)) delete tradeLeftLast[k];
    for (const k of Object.keys(tradeRightLast)) delete tradeRightLast[k];
    renderApp();
  };

  tb.appendChild(inp);
  tb.appendChild(clearBtn);

  const leftT = tradeSideTotal(tradeLeftCounts);
  const rightT = tradeSideTotal(tradeRightCounts);
  const diff = Math.abs(leftT - rightT);

  let verdict = t(lang, "trade.fair");
  let verdictClass = "trade-score--fair";
  if (diff > 50) {
    if (leftT > rightT) {
      verdict = t(lang, "trade.win_left");
      verdictClass = "trade-score--win-left";
    } else {
      verdict = t(lang, "trade.win_right");
      verdictClass = "trade-score--win-right";
    }
  }

  const scoreBox = document.createElement("div");
  scoreBox.className = `trade-score ${verdictClass}`;
  const big = document.createElement("div");
  big.className = "big";
  big.textContent = `${verdict} · ${leftT} vs ${rightT}`;
  const sub = document.createElement("div");
  sub.className = "trade-score-sub muted";
  sub.textContent = `${t(lang, "trade.left_tot")}: ${leftT} · ${t(lang, "trade.right_tot")}: ${rightT} · ${t(lang, "trade.diff")}: ${diff}`;
  scoreBox.appendChild(big);
  scoreBox.appendChild(sub);

  const grid = document.createElement("div");
  grid.className = "trade-shell";
  const filt = getFilteredUnits(q, tradeRarityFilter);

  wrap.appendChild(tb);
  wrap.appendChild(scoreBox);
  wrap.appendChild(buildRarityFilterBar("trade"));
  grid.appendChild(buildTradeHalf("left", filt));
  grid.appendChild(buildTradeHalf("right", filt));
  wrap.appendChild(grid);
  return wrap;
}

function buildHomeView() {
  const d = document.createElement("div");
  d.className = "view-home";

  const disclaimer = document.createElement("div");
  disclaimer.className = "fanmade-banner";
  disclaimer.innerHTML = `<strong>${escapeHtml(t(lang, "main.home_badge"))}</strong> — ${escapeHtml(t(lang, "main.home_fanmade_notice"))}`;
  d.appendChild(disclaimer);

  const hero = document.createElement("section");
  hero.className = "hero hero--fanmade";
  hero.innerHTML = `
    <p class="hero-kicker">${escapeHtml(t(lang, "main.home_tagline"))}</p>
    <h2>${escapeHtml(t(lang, "main.bienvenida"))}</h2>
    <p class="hero-sub muted">${escapeHtml(t(lang, "main.home_subtitle"))}</p>
    <div class="hero-badges">
      <span class="hero-badge hero-badge--fanmade">${escapeHtml(t(lang, "main.home_badge"))}</span>
      <span class="hero-badge hero-badge--live">${escapeHtml(t(lang, "main.home_stat_live"))}</span>
    </div>`;

  const stats = document.createElement("div");
  stats.className = "hero-stats";
  const statItems = [
    [String(units.length), t(lang, "main.home_stat_units")],
    ["13", t(lang, "main.home_stat_votes")],
    ["✓", t(lang, "main.home_stat_live")],
  ];
  for (const [val, lbl] of statItems) {
    const cell = document.createElement("div");
    cell.className = "hero-stat";
    cell.innerHTML = `<span class="hero-stat-val">${escapeHtml(val)}</span><span class="hero-stat-lbl">${escapeHtml(lbl)}</span>`;
    stats.appendChild(cell);
  }
  hero.appendChild(stats);

  const thanks = document.createElement("p");
  thanks.className = "muted hero-value-list-credit";
  thanks.append(
    document.createTextNode(`${t(lang, "main.list_values_thanks")} `),
  );
  const listLink = document.createElement("a");
  listLink.href = OFFICIAL_VALUE_LIST_URL;
  listLink.target = "_blank";
  listLink.rel = "noopener noreferrer";
  listLink.textContent = t(lang, "main.official_list_link");
  thanks.appendChild(listLink);
  hero.appendChild(thanks);
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
  if (testerAccessAllowed()) {
    card("tester", "⚙", t(lang, "nav.tester"), t(lang, "main.tester_desc"), "#/tester");
  }

  d.appendChild(grid);

  const foot = document.createElement("p");
  foot.className = "muted foot-credits-link";
  const a = document.createElement("a");
  a.href = "#/credits";
  a.textContent = `→ ${t(lang, "nav.credits")}`;
  foot.appendChild(a);
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

function parseGeminiJson(output) {
  const raw = String(output || "").trim();
  try {
    // Buscamos el JSON dentro del texto por si la IA añade algo fuera
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No se encontró JSON");
    return JSON.parse(match[0]);
  } catch (err) {
    // Fallback tolerante: si el JSON viene cortado, intentamos rescatar
    // los objetos completos dentro de "found": [ {..}, {..}, ... ].
    try {
      const start = raw.indexOf('"found"');
      if (start < 0) throw err;
      const arrStart = raw.indexOf("[", start);
      if (arrStart < 0) throw err;
      const items = [];
      let i = arrStart + 1;
      while (i < raw.length) {
        while (i < raw.length && raw[i] !== "{") {
          if (raw[i] === "]") return { found: items };
          i++;
        }
        if (i >= raw.length) break;
        const objStart = i;
        let depth = 0;
        let inStr = false;
        let esc = false;
        while (i < raw.length) {
          const ch = raw[i];
          if (inStr) {
            if (esc) esc = false;
            else if (ch === "\\") esc = true;
            else if (ch === '"') inStr = false;
          } else {
            if (ch === '"') inStr = true;
            else if (ch === "{") depth++;
            else if (ch === "}") {
              depth--;
              if (depth === 0) {
                const chunk = raw.slice(objStart, i + 1);
                try {
                  const parsed = JSON.parse(chunk);
                  if (parsed && typeof parsed === "object") items.push(parsed);
                } catch (_) {
                  // objeto corrupto → lo ignoramos
                }
                i++;
                break;
              }
            }
          }
          i++;
        }
        // si se cortó antes de cerrar "}", salimos y devolvemos lo rescatado
        if (depth !== 0) break;
      }
      return { found: items };
    } catch (_) {
      console.error("Error parseando JSON de Gemini:", raw);
      return { found: [] };
    }
  }
}

function updateScannerCdCells(found) {
  const cells = document.querySelectorAll(".scanner-cd-cell");
  cells.forEach((cell, index) => {
    const valueEl = cell.querySelector(".scanner-cd-val");
    const labelEl = cell.querySelector(".scanner-cd-lbl");
    const item = found[index];
    if (!valueEl || !labelEl) return;
    if (item) {
      valueEl.textContent = String(item.qty);
      labelEl.textContent = item.name;
    } else {
      valueEl.textContent = "";
      labelEl.textContent = "";
    }
  });
}

function normScanToken(s) {
  return String(s || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("es")
    .normalize("NFC");
}

function normScanTokenLoose(s) {
  return String(s || "")
    .trim()
    .replace(/\s+/g, " ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es")
    .replace(/[^a-z0-9 ]+/g, "")
    .trim();
}

function parseVoteFromGemini(v) {
  if (v === null || v === undefined) return 1;
  if (typeof v === "number" && Number.isFinite(v)) {
    return Math.max(1, Math.min(13, Math.round(v)));
  }
  const s = String(v).trim().toLowerCase();
  if (!s) return 1;
  if (s === "voto" || s === "vote") return 1;
  const m = s.match(/^(?:voto|vote)[_\s-]?(\d{1,2})$/i);
  if (m) return Math.max(1, Math.min(13, Number(m[1]) || 1));
  const digits = s.replace(/\D/g, "");
  if (digits) return Math.max(1, Math.min(13, Number(digits) || 1));
  return 1;
}

function buildScannerUnitLookup() {
  /** @type {Record<string, any>} */
  const byNorm = Object.create(null);
  for (const u of units) {
    const es = normScanToken(u?.nombre);
    const en = normScanToken(u?.nombre_en);
    if (es) byNorm[es] = u;
    if (en && !(en in byNorm)) byNorm[en] = u;

    const esL = normScanTokenLoose(u?.nombre);
    const enL = normScanTokenLoose(u?.nombre_en);
    if (esL && !(esL in byNorm)) byNorm[esL] = u;
    if (enL && !(enL in byNorm)) byNorm[enL] = u;
  }
  return byNorm;
}

function pickUnitFromLookup(lookup, rawName) {
  const key = normScanToken(rawName);
  if (lookup[key]) return lookup[key];
  const keyL = normScanTokenLoose(rawName);
  if (lookup[keyL]) return lookup[keyL];
  return null;
}
async function scanWithGemini(base64Image, candidates, maxCount = 6) {
  try {
    const genAI = new GoogleGenerativeAI(GEMINI_KEY);
    
    // Usamos el modelo 1.5 que es el que tiene "ojos" para los detalles
    const model = genAI.getGenerativeModel({ 
      model: "gemini-1.5-flash-latest",
      generationConfig: {
        maxOutputTokens: 2048,
        temperature: 0, 
        responseMimeType: "application/json" 
      }
    });

    const imageData = base64Image.split(",")[1];
    const pool = Array.isArray(candidates) && candidates.length ? candidates : units;
    const namesList = pool.map(u => u.nombre).filter(Boolean).join(", ");

    const prompt = `ACTÚA COMO UN EXPERTO EN RECONOCIMIENTO VISUAL.
TU TAREA: Escanear las cartas de personajes en la imagen adjunta.

REGLAS CRÍTICAS:
1. SOLO identifica unidades que estén EN LA IMAGEN.
2. Compara el físico (pelo, ropa, postura) con esta lista: [${namesList}]
3. Si hay varias unidades iguales, cuéntalas todas (qty).
4. VOTOS (Icono circular): Identifícalo por color (Rojo, Azul, Verde, etc.) y asígnale el ID "votoX" correspondiente.

RESPUESTA (SOLO JSON):
{"found": [{"name": "Nombre exacto", "vote": "votoX", "qty": 1}]}`;

    // CAMBIO VITAL: Estructura de "parts" explícita
    const result = await model.generateContent({
      contents: [{
        role: 'user',
        parts: [
          {
            inlineData: {
              mimeType: "image/png",
              data: imageData
            }
          },
          {
            text: prompt
          }
        ]
      }]
    });

    const response = await result.response;
    const text = response.text().trim();
    
    // Esto te ayudará a ver en la consola si la IA está diciendo tonterías antes de fallar
    console.log("Respuesta cruda de Gemini:", text);

    return parseGeminiJson(text);

  } catch (error) {
    console.error("Error real en el envío a Gemini:", error);
    throw new Error("Fallo en el escaneo: " + error.message);
  }
}
function scannerImageFromSrc(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.loading = "eager";
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = String(src || "");
  });
}

function scannerVectorFromImage(img, size = SCANNER_VECTOR_SIZE, centerRatio = 1) {
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
  const raw = ctx.getImageData(0, 0, size, size).data;
  return scannerFeatureFromImageData(raw, size, size);
}


function scannerSimilarity(vecA, vecB) {
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

function scannerHistogramSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let num = 0;
  let den = 0;
  for (let i = 0; i < a.length; i++) {
    num += Math.min(a[i], b[i]);
    den += Math.max(a[i], b[i]);
  }
  return den > 0 ? num / den : 0;
}

async function scannerTemplateForUnit(unit) {
  if (!unit?.imagen) return null;
  if (scannerTemplateCache.has(unit.nombre)) return scannerTemplateCache.get(unit.nombre);
  try {
    const img = await scannerImageFromSrc(assetUrl(unit.imagen));
    const full = scannerVectorFromImage(img);
    const center = scannerVectorFromImage(img, SCANNER_VECTOR_SIZE, 0.7);
    const packed = { full, center };
    scannerTemplateCache.set(unit.nombre, packed);
    return packed;
  } catch (_) {
    scannerTemplateCache.set(unit.nombre, null);
    return null;
  }
}

function scannerIou(a, b) {
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

function scannerBuildCandidates(img) {
  // Eliminamos todos los recortes raros que fallan.
  // Enviamos solo la imagen completa para que la IA no se confunda.
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  
  // Retornamos un único "crop" que es la imagen entera.
  return [{
    x: 0,
    y: 0,
    w: w,
    h: h
  }];
}

async function scannerEstimateCardCountFromDataUrl(dataUrl) {
  try {
    const img = await scannerImageFromSrc(dataUrl);
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    const canvas = document.createElement("canvas");
    const dw = Math.min(420, w);
    const dh = Math.max(1, Math.round((h / w) * dw));
    canvas.width = dw;
    canvas.height = dh;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return 1;
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
    let runs = 0;
    let x = 0;
    while (x < dw) {
      while (x < dw && colScore[x] < thr) x++;
      if (x >= dw) break;
      const x0 = x;
      while (x < dw && colScore[x] >= thr) x++;
      const x1 = x - 1;
      if (x1 - x0 + 1 >= Math.floor(dw * 0.12)) runs++;
    }
    return Math.max(1, Math.min(12, runs || 1));
  } catch {
    return 1;
  }
}

const scannerVoteTplCache = new Map();

async function scannerVoteTemplates() {
  if (scannerVoteTplCache.size) return scannerVoteTplCache;
  for (let i = 1; i <= 13; i++) {
    try {
      const img = await scannerImageFromSrc(assetUrl(`assets/votos/voto${i}.png`));
      const v = scannerVectorFromImage(img, 32, 1);
      if (v) scannerVoteTplCache.set(i, v);
    } catch (_) {
      // si falta algún asset, lo ignoramos
    }
  }
  return scannerVoteTplCache;
}

async function scannerDetectVoteFromCrop(img, cropRect) {
  // Recortamos esquinas donde suele estar el logo (abajo izq/der).
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const x = Math.max(0, cropRect.x);
  const y = Math.max(0, cropRect.y);
  const cw = Math.max(1, cropRect.w);
  const ch = Math.max(1, cropRect.h);
  const corner = Math.floor(Math.min(cw, ch) * 0.38);
  const corners = [
    { x: x, y: y + ch - corner, w: corner, h: corner }, // bottom-left
    { x: x + cw - corner, y: y + ch - corner, w: corner, h: corner }, // bottom-right
  ];
  const tpl = await scannerVoteTemplates();
  let best = { vote: 1, sim: 0 };
  for (const c of corners) {
    const vec = scannerVectorFromCrop(img, c, 1);
    if (!vec) continue;
    for (const [vote, tvec] of tpl.entries()) {
      const simEdge = scannerSimilarity(vec.edge, tvec.edge);
      const simOcc = scannerSimilarity(vec.occ, tvec.occ);
      const simHist = scannerHistogramSimilarity(vec.hist, tvec.hist);
      const sim = simEdge * 0.55 + simOcc * 0.25 + simHist * 0.2;
      if (sim > best.sim) best = { vote, sim };
    }
  }
  // threshold: si no hay coincidencia clara, devolvemos voto1 (sin voto vinculante).
  return best.sim >= 0.62 ? best.vote : 1;
}

function scannerVectorFromCrop(img, crop, centerRatio = 1) {
  const canvas = document.createElement("canvas");
  canvas.width = SCANNER_VECTOR_SIZE;
  canvas.height = SCANNER_VECTOR_SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  const c = Math.max(0.2, Math.min(1, centerRatio));
  const cx = crop.x + (crop.w * (1 - c)) / 2;
  const cy = crop.y + (crop.h * (1 - c)) / 2;
  const cw = crop.w * c;
  const ch = crop.h * c;
  ctx.drawImage(
    img,
    cx,
    cy,
    cw,
    ch,
    0,
    0,
    SCANNER_VECTOR_SIZE,
    SCANNER_VECTOR_SIZE,
  );
  const raw = ctx.getImageData(0, 0, SCANNER_VECTOR_SIZE, SCANNER_VECTOR_SIZE).data;
  return scannerFeatureFromImageData(raw, SCANNER_VECTOR_SIZE, SCANNER_VECTOR_SIZE);
}

function scannerFeatureFromImageData(raw, width, height) {
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
    const rb = r >> 6;
    const gb = g >> 6;
    const bb = b >> 6;
    bins[(rb << 4) | (gb << 2) | bb] += 1;
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
        const satBin = sat > 0.28 ? 1 : 0;
        hist[satBin * 6 + hueBin] += 1;
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

async function scannerAnalyzeImageDataUrl(dataUrl) {
  const img = await scannerImageFromSrc(dataUrl);
  const crops = scannerBuildCandidates(img);
  const rawHits = [];
  /** @type {null | {unit:any, similarity:number, rect:any}} */
  let bestGlobal = null;
  for (const crop of crops) {
    const srcFull = scannerVectorFromCrop(img, crop, 1);
    const srcCenter = scannerVectorFromCrop(img, crop, 0.7);
    if (!srcFull || !srcCenter) continue;
    let best = null;
    let second = null;
    for (const unit of units) {
      const tpl = await scannerTemplateForUnit(unit);
      if (!tpl?.full || !tpl?.center) continue;
      const simFullEdge = scannerSimilarity(srcFull.edge, tpl.full.edge);
      const simCenterEdge = scannerSimilarity(srcCenter.edge, tpl.center.edge);
      const simOcc =
        (scannerSimilarity(srcFull.occ, tpl.full.occ) +
          scannerSimilarity(srcCenter.occ, tpl.center.occ)) /
        2;
      const simHist =
        (scannerHistogramSimilarity(srcFull.hist, tpl.full.hist) +
          scannerHistogramSimilarity(srcCenter.hist, tpl.center.hist)) /
        2;
      const sim = simFullEdge * 0.25 + simCenterEdge * 0.45 + simOcc * 0.2 + simHist * 0.1;
      const row = { unit, similarity: sim };
      if (!best || sim > best.similarity) {
        second = best;
        best = row;
      } else if (!second || sim > second.similarity) {
        second = row;
      }
    }
    if (!best) continue;
    if (!bestGlobal || best.similarity > bestGlobal.similarity) {
      bestGlobal = { ...best, rect: crop };
    }
    const gap = best.similarity - (second?.similarity ?? 0);
    if (best.similarity < SCANNER_MATCH_THRESHOLD || gap < 0.006) continue;
    rawHits.push({ ...best, rect: crop });
  }

  rawHits.sort((a, b) => b.similarity - a.similarity);
  const selected = [];
  for (const h of rawHits) {
    let overlaps = false;
    for (const s of selected) {
      if (scannerIou(h.rect, s.rect) > 0.42) {
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
  const finalRows = [...merged.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return b.bestSimilarity - a.bestSimilarity;
  });
  if (finalRows.length) {
    // Adjuntamos voto detectado por icono (si procede)
    for (const row of finalRows) {
      // buscamos el mejor rect para esa unidad entre selected
      const bestRect = selected
        .filter((s) => s.unit?.nombre === row.unit?.nombre)
        .sort((a, b) => b.similarity - a.similarity)[0]?.rect;
      if (bestRect) row.vote = await scannerDetectVoteFromCrop(img, bestRect);
      else row.vote = 1;
    }
    return finalRows;
  }
  if (bestGlobal && bestGlobal.similarity >= 0.58) {
    const vote = await scannerDetectVoteFromCrop(img, bestGlobal.rect);
    return [{ unit: bestGlobal.unit, count: 1, bestSimilarity: bestGlobal.similarity, vote }];
  }
  return [];
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
      // 1) Intentamos detección local (más precisa si las plantillas cargan)
      let candidateUnits = null;
      let localRows = null;
      const maxCount = await scannerEstimateCardCountFromDataUrl(scannerTesterImageDataUrl);
      try {
        const local = await scannerAnalyzeImageDataUrl(scannerTesterImageDataUrl);
        localRows = Array.isArray(local) ? local : null;
        candidateUnits = localRows ? localRows.map((r) => r.unit).filter(Boolean) : null;
      } catch (_) {
        candidateUnits = null;
        localRows = null;
      }

      const matches = [];
      const foundItems = [];

        if (localRows && localRows.length) {
          for (const row of localRows) {
            const qty = Math.max(1, Math.min(999, Number(row.count) || 1));
            const voteNum = Math.max(1, Math.min(13, Number(row.vote) || 1));
            matches.push({
              unit: row.unit,
              count: qty,
              vote: voteNum,
              bestSimilarity: Number(row.bestSimilarity) || 0,
            });
            foundItems.push({ name: unitDisplayName(row.unit), qty });
          }
        } else {
          // 2) Fallback: IA, acotada por candidatas si existían
          const parsed = await scanWithGemini(scannerTesterImageDataUrl, candidateUnits, maxCount);

          const lookup = buildScannerUnitLookup();
          const cleaned = [];
          const seen = new Set();
          for (const item of parsed.found || []) {
            if (cleaned.length >= maxCount) break;
            const nm = String(item?.name ?? "").trim();
            if (!nm || seen.has(nm)) continue;
            seen.add(nm);
            cleaned.push(item);
          }
          for (const item of cleaned) {
            const qty = Math.max(1, Math.min(999, Number(item.qty) || 1));
            const voteNum = parseVoteFromGemini(item.vote);

            const rawName = item?.name ?? item?.unit ?? item?.nombre ?? "";
            const unit = pickUnitFromLookup(lookup, rawName);

            matches.push({
              unit: unit || { nombre: item.name, valor: 0, imagen: "", rareza: "" },
              count: qty,
              vote: voteNum,
              bestSimilarity: unit ? 1 : 0
            });

            foundItems.push({
              name: unit ? unitDisplayName(unit) : String(rawName || item.name || ""),
              qty
            });
          }
        }
        

        scannerTesterMatches = matches;
        
        // 3. Actualizamos los cuadraditos de la interfaz
        if (typeof updateScannerCdCells === "function") {
          updateScannerCdCells(foundItems);
        }

        if (!scannerTesterMatches.length) {
          scannerTesterNotice = "No se detectaron unidades.";
        } else {
          scannerTesterNotice = "";
        }
      } catch (e) {
        console.error("Error en el scanner:", e);
        scannerTesterError = "Error al conectar con la IA: " + (e.message || String(e));
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
        <span class="sim">V${row.vote || 1}</span>
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

  const filtered = getFilteredUnits(q, valuesRarityFilter);

  const unitsSection = document.createElement("section");
  unitsSection.className = "values-section";
  const unitsHead = document.createElement("h3");
  unitsHead.className = "values-section-title";
  unitsHead.textContent = t(lang, "values.units_heading");
  unitsSection.appendChild(unitsHead);

  if (!filtered.length) {
    const empty = document.createElement("p");
    empty.className = "values-empty muted";
    empty.textContent = t(lang, "values.no_results");
    unitsSection.appendChild(empty);
  } else {
    const unitsWrap = document.createElement("div");
    unitsWrap.className = "values-table-wrap";
    const unitsTable = document.createElement("table");
    unitsTable.className = "values-table values-table--units";
    unitsTable.innerHTML = `
      <thead><tr>
        <th></th>
        <th>${escapeHtml(t(lang, "values.col_unit"))}</th>
        <th>${escapeHtml(t(lang, "values.col_rarity"))}</th>
        <th>${escapeHtml(t(lang, "values.col_base"))}</th>
      </tr></thead>`;
    const tbody = document.createElement("tbody");
    for (const u of filtered) {
      const tr = document.createElement("tr");
      tr.className = cardRarityClass(u.rareza);
      const imgTd = document.createElement("td");
      imgTd.className = "values-cell-img";
      if (u.imagen) {
        const img = document.createElement("img");
        img.src = assetUrl(u.imagen);
        img.alt = "";
        imgTd.appendChild(img);
      }
      const nameTd = document.createElement("td");
      nameTd.className = "values-cell-name";
      nameTd.textContent = unitDisplayName(u);
      const rareTd = document.createElement("td");
      if (u.rareza) rareTd.appendChild(buildRarityBadge(u.rareza));
      const valTd = document.createElement("td");
      valTd.className = "values-cell-num";
      valTd.textContent = String(u.valor);
      tr.appendChild(imgTd);
      tr.appendChild(nameTd);
      tr.appendChild(rareTd);
      tr.appendChild(valTd);
      tbody.appendChild(tr);
    }
    unitsTable.appendChild(tbody);
    unitsWrap.appendChild(unitsTable);
    unitsSection.appendChild(unitsWrap);
  }
  wrap.appendChild(unitsSection);

  const votesSection = document.createElement("section");
  votesSection.className = "values-section";
  const votesHead = document.createElement("h3");
  votesHead.className = "values-section-title";
  votesHead.textContent = t(lang, "values.votes_heading");
  const votesHint = document.createElement("p");
  votesHint.className = "values-section-hint muted";
  votesHint.textContent = t(lang, "values.votes_hint");
  votesSection.appendChild(votesHead);
  votesSection.appendChild(votesHint);

  if (filtered.length) {
    const votesWrap = document.createElement("div");
    votesWrap.className = "values-table-wrap values-table-wrap--wide";
    const votesTable = document.createElement("table");
    votesTable.className = "values-table values-table--votes";
    const voteHead = document.createElement("thead");
    const headRow = document.createElement("tr");
    const unitTh = document.createElement("th");
    unitTh.className = "values-sticky-col";
    unitTh.textContent = t(lang, "values.col_unit");
    headRow.appendChild(unitTh);
    for (let i = 1; i <= 13; i++) {
      const th = document.createElement("th");
      th.textContent = `V${i}`;
      headRow.appendChild(th);
    }
    voteHead.appendChild(headRow);
    votesTable.appendChild(voteHead);

    const voteBody = document.createElement("tbody");
    for (const u of filtered) {
      const tr = document.createElement("tr");
      tr.className = cardRarityClass(u.rareza);
      const nameTd = document.createElement("td");
      nameTd.className = "values-sticky-col values-cell-name";
      nameTd.textContent = unitDisplayName(u);
      tr.appendChild(nameTd);
      for (let i = 1; i <= 13; i++) {
        const td = document.createElement("td");
        td.className = "values-cell-num";
        td.textContent = String(voteValueForUnit(u, `voto${i}`));
        tr.appendChild(td);
      }
      voteBody.appendChild(tr);
    }
    votesTable.appendChild(voteBody);
    votesWrap.appendChild(votesTable);
    votesSection.appendChild(votesWrap);
  }
  wrap.appendChild(votesSection);

  return wrap;
}

function buildCreditsView() {
  const d = document.createElement("div");
  d.className = "credits-box view-credits";
  d.innerHTML = `<h2 style="margin-top:0">${escapeHtml(t(lang, "credits.title"))}</h2>`;

  const intro = document.createElement("p");
  intro.className = "muted";
  intro.textContent = t(lang, "credits.subtitle");
  d.appendChild(intro);
  const badge = document.createElement("p");
  badge.className = "credits-badge";
  badge.textContent = t(lang, "credits.badge");
  d.appendChild(badge);

  const grid = document.createElement("div");
  grid.className = "credits-grid";
  for (const m of CREDITS_PROFILES) {
    const card = document.createElement("article");
    card.className = `credits-card ${m.accent}`;
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

    const meta = document.createElement("div");
    meta.className = "credits-meta";
    meta.innerHTML = `
      <h3>${escapeHtml(m.handle)}</h3>
      <p class="muted">${escapeHtml(t(lang, m.roleKey))}</p>
    `;
    card.appendChild(avatarWrap);
    card.appendChild(meta);

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
    card.appendChild(actions);
    grid.appendChild(card);
  }
  d.appendChild(grid);
  const foot = document.createElement("p");
  foot.className = "muted credits-foot";
  foot.textContent = t(lang, "credits.foot");
  d.appendChild(foot);
  return d;
}

function currentRoute() {
  const h = (location.hash || "#/").replace(/^#/, "") || "/";
  if (h === "/" || h === "/home") return "home";
  if (h.startsWith("/calc")) return "calc";
  if (h.startsWith("/trade")) return "trade";
  if (h.startsWith("/values")) return "values";
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
  shell.className = "app-shell";

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
  main.className = "content";

  let route = currentRoute();
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
  localStorage.setItem("tdhub_lang", newLang);
  if (voteDialogEl?.open && modalCtx.unit) {
    voteDialogEl.close();
    queueMicrotask(() => openVoteSheet(modalCtx.mode, modalCtx.unit, modalCtx.side));
  }
  renderApp();
}

async function bootstrap() {
  const root = document.getElementById("app");
  root.innerHTML = `<p class="muted" style="padding:24px;text-align:center">Cargando datos…</p>`;
  try {
    const loaded = await loadUnitsAndVotes();
    units = loaded.units;
    vote_values = loaded.vote_values;
  } catch (e) {
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
  renderApp();
  resolveTesterIpAccess().then(() => renderApp());

  window.addEventListener("hashchange", () => {
    renderApp();
    if (voteDialogEl?.open && modalCtx.unit) voteDialogEl.close();
  });
}

bootstrap();
