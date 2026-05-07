import { assetUrl } from "./assetUrl.js";
import { loadUnitsAndVotes } from "./supabase/loadData.js";
import { rarityRank, normalizeRarity } from "./rarity.js";
import { t } from "./strings.js";

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

/** @type {string} última búsqueda calculadora / trade */
let lastSearchCalc = "";
let lastSearchTrade = "";

/** Tras escribir en el buscador, re-render quita foco — lo restauramos solo en ese caso. */
let pendingToolbarFocusRoute = /** @type {null | "calc" | "trade"} */ (null);

/** Cuenta atrás pantalla Scanner (se limpia al cambiar de ruta). */
let scannerCountdownTimer = /** @type {ReturnType<typeof setInterval> | null} */ (null);

/** Friday May 29, 2026, 20:00 PM (Spain mainland). */
const SCANNER_LAUNCH_AT_MS = Date.parse("2026-05-08T20:00:00+02:00"); 

const TD_MOBILE_MQ =
  typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(max-width: 640px)")
    : null;

const SCANNER_TEST_USER = "UN66467019";
const SCANNER_TEST_PASS = "1234";
const SCANNER_VECTOR_SIZE = 40;
const SCANNER_MATCH_THRESHOLD = 0.76;
const GEMINI_KEY = "AIzaSyAmzPFMvsZvDLGb5Hp383lOaZipYLT4Ud0";
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

let scannerTesterAuth = false;
let scannerTesterError = "";
let scannerTesterNotice = "";
let scannerTesterImageDataUrl = "";
let scannerTesterAnalyzing = false;
let scannerTesterMatches = [];
const scannerTemplateCache = new Map();
const routeScrollTop = Object.create(null);
const tradePickerScrollTop = { left: 0, right: 0 };

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
  if (route !== "calc" && route !== "trade" && route !== "tester") return;
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

function filterSortUnits(q) {
  const query = (q || "").toLowerCase().trim();
  const list = [...units].sort((a, b) => {
    const ra = rarityRank(a.rareza);
    const rb = rarityRank(b.rareza);
    if (ra !== rb) return ra - rb;
    return a.nombre.localeCompare(b.nombre, "es", { sensitivity: "base" });
  });

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
    const n = a.unit.nombre.localeCompare(b.unit.nombre, "es", {
      sensitivity: "base",
    });
    if (n !== 0) return n;
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
      slot.className = "trade-inv-slot";
      const vi = Number(String(voteKey).replace(/\D/g, "")) || 0;
      slot.title =
        vi > 0
          ? `${unitDisplayName(u)} · V${vi}`
          : unitDisplayName(u);

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

  for (const u of filterSortUnits(q)) {
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

    const name = document.createElement("div");
    name.className = "unit-name";
    name.textContent = unitDisplayName(u);

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
    card.appendChild(name);
    card.appendChild(ctl);
    grid.appendChild(card);
  }

  wrap.appendChild(tb);
  wrap.appendChild(grid);
  return wrap;
}

function buildTradeHalf(sideName, filtered) {
  const col = document.createElement("div");
  col.className = `trade-col ${sideName}`;
  const h = document.createElement("h3");
  h.textContent =
    sideName === "left" ? t(lang, "trade.left") : t(lang, "trade.right");
  col.appendChild(h);

  col.appendChild(buildTradeInventory(sideName));

  const cap = document.createElement("div");
  cap.className = "trade-picker-caption muted";
  cap.textContent = t(lang, "trade.picker_caption");
  col.appendChild(cap);

  const listWrap = document.createElement("div");
  listWrap.className = "trade-picker";
  listWrap.dataset.side = sideName;

  const cmap =
    sideName === "left" ? tradeLeftCounts : tradeRightCounts;
  const lmap =
    sideName === "left" ? tradeLeftLast : tradeRightLast;

  for (const u of filtered) {
    const row = document.createElement("div");
    row.className = "trade-row";

    const face = document.createElement("img");
    face.className = "face";
    face.src = u.imagen ? assetUrl(u.imagen) : "";

    const meta = document.createElement("div");
    meta.className = "trade-meta";
    const nEl = document.createElement("div");
    nEl.className = "name";
    nEl.textContent = unitDisplayName(u);
    const vEl = document.createElement("div");
    vEl.className = "val";
    vEl.textContent = `${u.valor}`;
    meta.appendChild(nEl);
    meta.appendChild(vEl);

    const vt = document.createElement("button");
    vt.type = "button";
    vt.className = "vote-mini";
    const vtImg = document.createElement("img");
    vtImg.src = tradeVoteIconSrc(sideName, u.nombre);
    vtImg.alt = "";
    vt.appendChild(vtImg);
    vt.onclick = () => openVoteSheet("trade", u, sideName);

    const ctl = document.createElement("div");
    ctl.className = "controls";
    const lbl = document.createElement("span");
    lbl.textContent = String(tradeSumForUnit(sideName, u.nombre));
    lbl.style.minWidth = "22px";
    lbl.style.fontWeight = "700";
    lbl.style.color = "#fff";

    const bminus = document.createElement("button");
    bminus.type = "button";
    bminus.className = "round minus";
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
        lmap[u.nombre] ||
        pickActiveVote(cmap, lmap, u.nombre, "voto1");
      adjustTradeVotes(sideName, u.nombre, vk, 1);
      renderApp();
    };
    ctl.appendChild(bminus);
    ctl.appendChild(lbl);
    ctl.appendChild(bplus);

    row.appendChild(face);
    row.appendChild(meta);
    row.appendChild(vt);
    row.appendChild(ctl);
    listWrap.appendChild(row);
  }
  col.appendChild(listWrap);
  return col;
}

function buildTradeView() {
  const q = lastSearchTrade;
  const wrap = document.createElement("div");
  wrap.className = "view-trade";

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

  let verdict = `${t(lang, "trade.fair")}`;
  let vcol = "#facc15";
  if (diff > 50) {
    if (leftT > rightT) {
      verdict = t(lang, "trade.win_left");
      vcol = "#22c55e";
    } else {
      verdict = t(lang, "trade.win_right");
      vcol = "#22c55e";
    }
  }

  const scoreBox = document.createElement("div");
  scoreBox.className = "trade-score";
  const big = document.createElement("div");
  big.className = "big";
  big.style.color = vcol;
  big.textContent = `${verdict} · ${leftT} vs ${rightT}`;
  const sub = document.createElement("div");
  sub.className = "muted";
  sub.style.marginTop = "0.35rem";
  sub.textContent = `${t(lang, "trade.left_tot")}: ${leftT} · ${t(lang, "trade.right_tot")}: ${rightT} · ${t(lang, "trade.diff")}: ${diff}`;
  scoreBox.appendChild(big);
  scoreBox.appendChild(sub);

  const hint = document.createElement("p");
  hint.className = "trade-didactic-hint muted";
  hint.textContent = t(lang, "trade.didactic_intro");

  const grid = document.createElement("div");
  grid.className = "trade-shell";
  const filt = filterSortUnits(q);

  grid.appendChild(buildTradeHalf("left", filt));
  grid.appendChild(buildTradeHalf("right", filt));

  wrap.appendChild(tb);
  wrap.appendChild(scoreBox);
  wrap.appendChild(hint);
  wrap.appendChild(grid);
  return wrap;
}

function buildHomeView() {
  const d = document.createElement("div");
  d.className = "view-home";
  d.innerHTML = `
    <div class="hero">
      <h2>${escapeHtml(t(lang, "main.bienvenida"))}</h2>
      <p class="muted">${escapeHtml(t(lang, "main.home_subtitle"))}</p>
      <p><span class="badge" style="display:inline-block;margin-top:8px">${escapeHtml(t(lang, "main.home_badge"))}</span></p>
    </div>`;
  const hero = d.querySelector(".hero");
  if (hero) {
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
    const badgeP = hero.querySelector("p:last-of-type");
    if (badgeP?.querySelector(".badge")) hero.insertBefore(thanks, badgeP);
    else hero.appendChild(thanks);
  }
  const grid = document.createElement("div");
  grid.className = "home-cards";

  function card(klass, heading, txt, goto) {
    const el = document.createElement("div");
    el.className = `home-card ${klass}`.trim();
    el.innerHTML = `<h3>${escapeHtml(heading)}</h3><p class="muted" style="white-space:pre-line">${escapeHtml(txt)}</p>`;
    const b = document.createElement("button");
    b.textContent = t(lang, "main.open");
    b.onclick = () => navigate(goto);
    el.appendChild(b);
    grid.appendChild(el);
  }

  card("", t(lang, "nav.calc"), t(lang, "main.calc_desc"), "#/calc");
  card("trade", t(lang, "nav.trade"), t(lang, "main.trade_desc"), "#/trade");
  card("scanner", t(lang, "nav.scanner"), t(lang, "main.scanner_desc"), "#/scanner");
  card("scanner", t(lang, "nav.tester"), t(lang, "main.tester_desc"), "#/tester");

  const foot = document.createElement("p");
  foot.className = "muted foot-credits-link";
  const a = document.createElement("a");
  a.href = "#/credits";
  a.textContent = `→ ${t(lang, "nav.credits")}`;
  foot.appendChild(a);
  d.appendChild(grid);
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
  try {
    // Buscamos el JSON dentro del texto por si la IA añade algo fuera
    const match = output.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No se encontró JSON");
    return JSON.parse(match[0]);
  } catch (err) {
    console.error("Error parseando JSON de Gemini:", output);
    return { found: [] };
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

async function scanWithGemini(baseBase64) {
  const imageBase64Only = baseBase64.split(",").pop();
  const namesList = units.map(u => u.nombre).join(", ");
  
  const promptText = `Identifica las unidades de Sorcerer TD. Solo usa estos nombres: [${namesList}]. Responde JSON: {"found": [{"name": "Nombre", "qty": 1}]}`;

  const googleUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`;
  const finalUrl = `https://corsproxy.io/?${encodeURIComponent(googleUrl)}`;

  const resp = await fetch(finalUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: promptText },
          { inline_data: { mime_type: "image/png", data: imageBase64Only } }
        ]
      }],
      generationConfig: { 
        response_mime_type: "application/json", 
        temperature: 0.1 
      }
    })
  });

  if (!resp.ok) {
    const errorText = await resp.text();
    throw new Error("Fallo en la comunicación: " + errorText);
  }

  const json = await resp.json();
  
  // A veces la respuesta viene con caracteres extraños de Markdown, esto lo limpia
  let rawText = json.candidates[0].content.parts[0].text;
  if (rawText.includes("```json")) {
    rawText = rawText.replace(/```json|```/g, "").trim();
  }
  
  return JSON.parse(rawText);
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
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const side = Math.min(w, h);
  const out = [];
  out.push({ x: (w - side) / 2, y: (h - side) / 2, w: side, h: side });
  const grids = [2, 3, 4, 5, 6];
  for (const g of grids) {
    const cw = Math.floor(w / g);
    const ch = Math.floor(h / g);
    const c = Math.min(cw, ch);
    if (c < 20) continue;
    for (let gy = 0; gy < g; gy++) {
      for (let gx = 0; gx < g; gx++) {
        const x = gx * cw + Math.max(0, (cw - c) / 2);
        const y = gy * ch + Math.max(0, (ch - c) / 2);
        out.push({ x, y, w: c, h: c });
      }
    }
  }
  return out;
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
    if (best.similarity < SCANNER_MATCH_THRESHOLD || gap < 0.01) continue;
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
    if (selected.length >= 8) break;
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
  if (finalRows.length) return finalRows;
  if (bestGlobal && bestGlobal.similarity >= 0.58) {
    return [{ unit: bestGlobal.unit, count: 1, bestSimilarity: bestGlobal.similarity }];
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

  if (!scannerTesterAuth) {
    const form = document.createElement("form");
    form.className = "scanner-login";
    form.innerHTML = `
      <label>
        <span>${escapeHtml(t(lang, "scanner.user"))}</span>
        <input name="user" type="text" autocomplete="username" required />
      </label>
      <label>
        <span>${escapeHtml(t(lang, "scanner.password"))}</span>
        <input name="pass" type="password" autocomplete="current-password" required />
      </label>
      <button type="submit">${escapeHtml(t(lang, "scanner.login"))}</button>
    `;
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const fd = new FormData(form);
      const user = String(fd.get("user") || "");
      const pass = String(fd.get("pass") || "");
      if (user === SCANNER_TEST_USER && pass === SCANNER_TEST_PASS) {
        scannerTesterAuth = true;
        scannerResetNoticeError();
      } else {
        scannerTesterError = t(lang, "scanner.login_error");
      }
      renderApp();
    });
    if (scannerTesterError) {
      const err = document.createElement("p");
      err.className = "scanner-msg scanner-msg--error";
      err.textContent = scannerTesterError;
      card.appendChild(err);
    }
    card.appendChild(form);
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
      // 1. Llamamos a la IA (la función que pusimos antes)
      const parsed = await scanWithGemini(scannerTesterImageDataUrl);

      const matches = [];
      const foundItems = [];

        // 2. Procesamos lo que la IA encontró
        for (const item of parsed.found || []) {
          const qty = Number(item.qty) || 1;
          
          // Buscamos en tu lista de unidades por nombre
          const unit = units.find(u => 
            u.nombre === item.name || u.nombre_en === item.name
          );

          matches.push({
            unit: unit || { nombre: item.name, valor: 0, imagen: "", rareza: "" },
            count: qty,
            bestSimilarity: unit ? 1 : 0
          });

          // Esto es para que se vean los nombres en las celdas
          foundItems.push({ 
            name: unit ? (lang === "es" ? unit.nombre : unit.nombre_en) : item.name, 
            qty 
          });
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
        <span class="sim">${escapeHtml(t(lang, "scanner.confidence"))}: ${(row.bestSimilarity * 100).toFixed(1)}%</span>
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

  wrap.appendChild(card);

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
  if (h.startsWith("/scanner")) return "scanner";
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

  const title = document.createElement("h1");
  title.textContent = "SORCERER CALCULATOR";

  side.appendChild(title);

  const nav = [
    { r: "#/home", k: "nav.home", rr: "home" },
    { r: "#/calc", k: "nav.calc", rr: "calc" },
    { r: "#/trade", k: "nav.trade", rr: "trade" },
    { r: "#/scanner", k: "nav.scanner", rr: "scanner" },
    { r: "#/tester", k: "nav.tester", rr: "tester" },
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

  const route = currentRoute();
  if (route === "home") main.appendChild(buildHomeView());
  else if (route === "calc") main.appendChild(buildCalcView());
  else if (route === "trade") main.appendChild(buildTradeView());
  else if (route === "scanner") main.appendChild(buildScannerView());
  else if (route === "tester") main.appendChild(buildTesterView());
  else main.appendChild(buildCreditsView());

  shell.appendChild(side);
  shell.appendChild(main);
  root.appendChild(shell);
  restoreRouteScroll(route, main);

  if (route === "calc") maybeRefocusToolbarSearch("calc");
  else if (route === "trade") maybeRefocusToolbarSearch("trade");
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

  window.addEventListener("hashchange", () => {
    renderApp();
    if (voteDialogEl?.open && modalCtx.unit) voteDialogEl.close();
  });
}

bootstrap();
