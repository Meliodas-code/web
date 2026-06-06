import { assetUrl } from "./assetUrl.js";
import { loadUnitsAndVotes } from "./supabase/loadData.js";
import {
  rarityRank,
  normalizeRarity,
  rarityLabel,
  RARITY_IDS_DESC,
} from "./rarity.js";
import { t } from "./strings.js";
import { VOTE_DISPLAY_ORDER, voteKey, voteDisplayLabel } from "./votes.js";
import { callEdgeFunction, edgeFunctionsConfigured } from "./edgeApi.js";
import {
  compareImageWithUnits,
  warmUnitTemplates,
} from "./visualMatch/index.js";

/** Lista de valores oficial (Sorcerer TD Value list). */
const OFFICIAL_VALUE_LIST_URL =
  "https://docs.google.com/spreadsheets/d/1--hVDdfHVSGLI1MF_Cmo0Te1Ir71KUxqnaqRX_CRCyI/htmlview?gid=0&pru=AAABnNPEMFQ*iMq033usqNrkyrEjGY0jeQ#gid=0";

/** @typedef {{nombre:string,nombre_en:string,valor:number,imagen:string,rareza:string}} Unit */

/** @type {Unit[]} */
let units = [];
/** @type {Record<string, Record<string, number>>} */
let vote_values = {};

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
    lastTradeBarFlex = { left: 1, right: 1 };
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
  scoreBox.appendChild(buildTradeCompareBar(leftT, rightT, diff));

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

function buildTradeCompareBar(leftT, rightT, diff) {
  const total = leftT + rightT;
  const leftFlex = total > 0 ? leftT : 1;
  const rightFlex = total > 0 ? rightT : 1;
  const leftPct = total > 0 ? Math.round((leftT / total) * 100) : 50;
  const rightPct = total > 0 ? 100 - leftPct : 50;

  const wrap = document.createElement("div");
  wrap.className = "trade-balance";

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

function buildVoteHeaderCell(vn) {
  const th = document.createElement("th");
  th.className = "values-vote-head";
  th.title = voteDisplayLabel(lang, vn);
  const img = document.createElement("img");
  img.src = assetUrl(`assets/votos/voto${vn}.png`);
  img.alt = voteDisplayLabel(lang, vn);
  img.onerror = () => img.remove();
  const lbl = document.createElement("span");
  lbl.textContent = voteDisplayLabel(lang, vn);
  th.appendChild(img);
  th.appendChild(lbl);
  return th;
}

function buildValuesRarityColumn(rarityId, rarityUnits) {
  const col = document.createElement("div");
  col.className = `values-rarity-col ${cardRarityClass(rarityId)}`;

  const head = document.createElement("div");
  head.className = "values-rarity-col-head";
  head.appendChild(buildRarityBadge(rarityId));

  const tableWrap = document.createElement("div");
  tableWrap.className = "values-rarity-col-body";
  const table = document.createElement("table");
  table.className = "values-table values-table--units-compact";
  table.innerHTML = `
    <thead><tr>
      <th>${escapeHtml(t(lang, "values.col_unit"))}</th>
      <th>${escapeHtml(t(lang, "values.col_base"))}</th>
    </tr></thead>`;

  const tbody = document.createElement("tbody");
  for (const u of rarityUnits) {
    const tr = document.createElement("tr");
    tr.className = cardRarityClass(u.rareza);
    const valTd = document.createElement("td");
    valTd.className = "values-cell-num";
    valTd.textContent = String(u.valor);
    tr.appendChild(buildValuesUnitCell(u));
    tr.appendChild(valTd);
    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  tableWrap.appendChild(table);
  col.appendChild(head);
  col.appendChild(tableWrap);
  return col;
}

function buildValuesUnitsGrid(filtered) {
  const grid = document.createElement("div");
  grid.className = "values-rarity-grid";

  /** @type {Map<string, typeof filtered>} */
  const byRarity = new Map();
  for (const u of filtered) {
    const key = normalizeRarity(u.rareza) || "other";
    if (!byRarity.has(key)) byRarity.set(key, []);
    byRarity.get(key).push(u);
  }

  const order = [
    ...RARITY_IDS_DESC.filter((id) => byRarity.has(id)),
    ...[...byRarity.keys()].filter((id) => !RARITY_IDS_DESC.includes(id)),
  ];

  for (const rarityId of order) {
    const list = byRarity.get(rarityId);
    if (!list?.length) continue;
    list.sort(compareUnits);
    grid.appendChild(buildValuesRarityColumn(rarityId, list));
  }

  return grid;
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
    unitsSection.appendChild(buildValuesUnitsGrid(filtered));
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
    for (const vn of VOTE_DISPLAY_ORDER) {
      headRow.appendChild(buildVoteHeaderCell(vn));
    }
    voteHead.appendChild(headRow);
    votesTable.appendChild(voteHead);

    const voteBody = document.createElement("tbody");
    for (const u of filtered) {
      const tr = document.createElement("tr");
      tr.className = cardRarityClass(u.rareza);
      tr.appendChild(buildValuesUnitCell(u, true));
      const baseVal = Number(u.valor) || 0;
      for (const vn of VOTE_DISPLAY_ORDER) {
        const td = document.createElement("td");
        const v = voteValueForUnit(u, voteKey(vn));
        td.className =
          v !== baseVal
            ? "values-cell-num values-cell-num--diff"
            : "values-cell-num";
        td.textContent = String(v);
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
  main.className = playEnter ? "content content--enter" : "content";

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
