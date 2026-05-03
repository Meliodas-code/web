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

function buildScannerView() {
  const wrap = document.createElement("div");
  wrap.className = "view-scanner";

  const bg = document.createElement("div");
  bg.className = "scanner-bg";
  bg.setAttribute("aria-hidden", "true");
  bg.innerHTML = `
    <div class="scanner-grid"></div>
    <div class="scanner-stripes"></div>
    <svg class="scanner-crane" viewBox="0 0 320 280" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id="sc-mast" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stop-color="#5a6578"/>
          <stop offset="100%" stop-color="#3d4555"/>
        </linearGradient>
        <linearGradient id="sc-jib" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#f59e0b"/>
          <stop offset="100%" stop-color="#d97706"/>
        </linearGradient>
      </defs>
      <rect x="138" y="48" width="44" height="200" rx="4" fill="url(#sc-mast)"/>
      <rect x="120" y="228" width="80" height="14" rx="3" fill="#2a3140"/>
      <path d="M 162 48 L 280 72 L 280 88 L 162 68 Z" fill="url(#sc-jib)" opacity="0.95"/>
      <rect x="268" y="72" width="8" height="120" rx="2" fill="#fbbf24"/>
      <line x1="272" y1="88" x2="272" y2="188" stroke="#1a1d26" stroke-width="2" opacity="0.35"/>
      <path d="M 268 188 Q 240 210 200 218" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round"/>
      <rect x="188" y="208" width="28" height="20" rx="2" fill="#475569" stroke="#f59e0b" stroke-width="1.5"/>
      <circle cx="272" cy="72" r="6" fill="#fbbf24"/>
    </svg>`;

  const card = document.createElement("div");
  card.className = "scanner-card";
  card.innerHTML = `
    <p class="scanner-kicker">${escapeHtml(t(lang, "scanner.kicker"))}</p>
    <h2 class="scanner-title">${escapeHtml(t(lang, "scanner.title"))}</h2>
    <p class="scanner-coming">${escapeHtml(t(lang, "scanner.coming"))}</p>
    <p class="scanner-wip">${escapeHtml(t(lang, "scanner.wip"))}</p>
    <div class="scanner-blink" aria-hidden="true">
      <span class="scanner-blink-dot"></span>
      <span>${escapeHtml(t(lang, "scanner.live_build"))}</span>
    </div>`;

  wrap.appendChild(bg);
  wrap.appendChild(card);
  return wrap;
}

function buildCreditsView() {
  const d = document.createElement("div");
  d.className = "credits-box view-credits";
  d.innerHTML =
    `<h2 style="margin-top:0">${escapeHtml(t(lang, "credits.title"))}</h2>
    <p>${escapeHtml(t(lang, "credits.hecho_por"))}</p>
    <p>${escapeHtml(t(lang, "credits.idea"))}</p>
    <p>${escapeHtml(t(lang, "credits.database"))}</p>`;
  return d;
}

function currentRoute() {
  const h = (location.hash || "#/").replace(/^#/, "") || "/";
  if (h === "/" || h === "/home") return "home";
  if (h.startsWith("/calc")) return "calc";
  if (h.startsWith("/trade")) return "trade";
  if (h.startsWith("/scanner")) return "scanner";
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

  root.innerHTML = "";

  const shell = document.createElement("div");
  shell.className = "app-shell";

  const side = document.createElement("aside");
  side.className = "sidebar";

  const title = document.createElement("h1");
  title.textContent = "TD HUB";

  side.appendChild(title);

  const nav = [
    { r: "#/home", k: "nav.home", rr: "home" },
    { r: "#/calc", k: "nav.calc", rr: "calc" },
    { r: "#/trade", k: "nav.trade", rr: "trade" },
    { r: "#/scanner", k: "nav.scanner", rr: "scanner" },
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
  else main.appendChild(buildCreditsView());

  shell.appendChild(side);
  shell.appendChild(main);
  root.appendChild(shell);

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

  renderApp();

  window.addEventListener("hashchange", () => {
    renderApp();
    if (voteDialogEl?.open && modalCtx.unit) voteDialogEl.close();
  });
}

bootstrap();
