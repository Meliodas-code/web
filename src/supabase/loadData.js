import { normalizeStability, parseDemanda } from "../demand.js";

/** Acepta voto1, Voto1, voto_1, voto-1, vote1, etc. */
const VOTO_KEY = /^(?:voto|vote)[_\s-]?(\d{1,2})$/i;

function normName(name) {
  return String(name || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("es")
    .normalize("NFC");
}

/** @returns {number | null} */
function asVoteNumber(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" && v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeRowKey(k) {
  return String(k || "")
    .trim()
    .replace(/[\u200B-\u200D\uFEFF]/g, "");
}

function getFirstPresentKey(row, candidates) {
  for (const cand of candidates) {
    if (Object.prototype.hasOwnProperty.call(row, cand)) return cand;
  }
  const lowered = {};
  for (const k of Object.keys(row)) {
    lowered[String(k).trim().toLowerCase()] = k;
  }
  for (const cand of candidates) {
    const fk = lowered[String(cand).trim().toLowerCase()];
    if (fk !== undefined) return fk;
  }
  return null;
}

/**
 * Primera columna de enlace cuyo valor es texto no vacío (evita elegir
 * `unit_name` u otras claves presentes pero null y saltarse `Nombre`).
 * @returns {string | null}
 */
function getVoteRowUnitLabel(row, keyCandidates) {
  for (const cand of keyCandidates) {
    const col = getFirstPresentKey(row, [cand]);
    if (!col) continue;
    const raw = row[col];
    if (raw === null || raw === undefined) continue;
    const s = String(raw).trim();
    if (s) return s;
  }
  return null;
}

function votesFromUnitRow(row, baseVal) {
  const votes = {};
  for (const [k0, v] of Object.entries(row || {})) {
    const m = VOTO_KEY.exec(normalizeRowKey(k0));
    const n = asVoteNumber(v);
    if (m && n !== null) votes[`voto${parseInt(m[1], 10)}`] = n;
  }
  const b = Number(baseVal) || 0;
  for (let i = 1; i < 13; i++) {
    const key = `voto${i}`;
    if (!(key in votes)) votes[key] = b;
  }
  votes.voto13 =
    votes.voto13 !== undefined ? votes.voto13 : votes.voto2 !== undefined ? votes.voto2 : b;
  return votes;
}

function mergeVoteRow(existing, voteRow) {
  const out = { ...(existing || {}) };
  for (const [k0, v] of Object.entries(voteRow || {})) {
    if (k0 === "unit_name" || k0 === "id") continue;
    const k = normalizeRowKey(k0);
    const m = VOTO_KEY.exec(k);
    const n = asVoteNumber(v);
    if (m && n !== null) out[`voto${parseInt(m[1], 10)}`] = n;
  }
  const base = out.voto2 !== undefined ? out.voto2 : out.voto1 !== undefined ? out.voto1 : 0;
  for (let i = 1; i < 13; i++) {
    const key = `voto${i}`;
    if (!(key in out)) out[key] = base;
  }
  out.voto13 =
    out.voto13 !== undefined ? out.voto13 : out.voto2 !== undefined ? out.voto2 : base;
  return out;
}

/**
 * Igual que `services/supabase_loader.py`: unidades normalizadas + mapa nombre -> valores voto.
 */
export async function loadUnitsAndVotes() {
  const url = (import.meta.env.VITE_SUPABASE_URL || "").replace(/\/$/, "");
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY || "";
  const unitsTable =
    import.meta.env.VITE_UNITS_TABLE?.trim() || "units";
  const votesTable =
    import.meta.env.VITE_VOTES_TABLE?.trim() || "unit_votes";

  if (!url || !key) {
    throw new Error(
      "Faltan VITE_SUPABASE_URL o VITE_SUPABASE_ANON_KEY. Crea web/.env con las variables."
    );
  }

  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
  };

  const unitsPath = `${url}/rest/v1/${encodeURIComponent(unitsTable)}?select=*`;
  const r = await fetch(unitsPath, { headers });
  if (!r.ok) {
    throw new Error(`Supabase units: ${r.status} ${await r.text()}`);
  }
  const rows = await r.json();
  if (!Array.isArray(rows)) throw new Error("Respuesta units inesperada");

  /** @type {Record<string, Record<string, number>>} */
  const vote_values = {};
  /** @type {Array<{nombre:string,nombre_en:string,valor:number,imagen:string,rareza:string,demanda:number|null,estabilidad:import("../demand.js").StabilityId}>} */
  const units_out = [];

  const unitNameCol = getFirstPresentKey(rows[0] || {}, [
    import.meta.env.VITE_UNITS_NAME_COLUMN?.trim(),
    "nombre",
    "Nombre",
    "name",
    "unit_name",
  ].filter(Boolean));

  for (const row of rows) {
    const nombreRaw =
      unitNameCol != null ? row[unitNameCol] : row.nombre ?? row.Nombre;
    if (nombreRaw === null || nombreRaw === undefined) continue;
    const nombre = String(nombreRaw).trim();
    if (!nombre) continue;
    const valor = row.valor != null ? Number(row.valor) : 0;
    units_out.push({
      nombre,
      nombre_en: row.nombre_en || "",
      valor,
      imagen: row.imagen || "",
      rareza: String(row.rareza || "").trim(),
      demanda: parseDemanda(row.demanda),
      estabilidad: normalizeStability(row.estabilidad),
    });
    vote_values[nombre] = votesFromUnitRow(row, valor);
  }

  const voteValuesByNorm = {};
  for (const name of Object.keys(vote_values)) {
    voteValuesByNorm[normName(name)] = name;
  }

  /** @type {Record<string, string>} normalizado nombre_en → clave `nombre` en units */
  const voteValuesByNormEn = {};
  for (const u of units_out) {
    const ne = String(u.nombre_en || "").trim();
    if (ne) voteValuesByNormEn[normName(ne)] = u.nombre;
  }

  if (votesTable) {
    const votesPath = `${url}/rest/v1/${encodeURIComponent(votesTable)}?select=*`;
    try {
      const rv = await fetch(votesPath, { headers });
      const rawBody = await rv.text();
      if (!rv.ok) {
        console.warn(
          `[TD HUB] No se pudieron leer los votos desde la tabla "${votesTable}": ${rv.status} ${rawBody.slice(0, 280)}`,
          "\n→ En Supabase: Authentication → Policies → la tabla debe permitir SELECT al rol anon (o desactiva RLS solo si es un proyecto público de solo lectura).",
          "\n→ Comprueba también el nombre exacto de la tabla (variable VITE_VOTES_TABLE en web/.env).",
        );
      } else {
        let vr;
        try {
          vr = JSON.parse(rawBody);
        } catch {
          console.warn(`[TD HUB] Respuesta no JSON al leer "${votesTable}".`);
          vr = null;
        }
        if (Array.isArray(vr)) {
          const configured = import.meta.env.VITE_VOTES_KEY_COLUMN?.trim();
          const keyCandidates = [];
          if (configured) keyCandidates.push(configured);
          keyCandidates.push(
            "unit_name",
            "nombre",
            "Nombre",
            "nombre_en",
            "name",
            "unit",
            "unidad",
          );

          let merged = 0;
          let skippedNoName = 0;
          for (const vrrow of vr) {
            const nameStr = getVoteRowUnitLabel(vrrow, keyCandidates);
            if (!nameStr) {
              skippedNoName++;
              continue;
            }
            const nk = normName(nameStr);
            const unit_name =
              voteValuesByNorm[nk] || voteValuesByNormEn[nk] || null;
            if (!unit_name) continue;
            vote_values[unit_name] = mergeVoteRow(vote_values[unit_name], vrrow);
            merged++;
          }
          if (vr.length && merged === 0) {
            const sample = vr[0];
            const sampleKeys =
              sample && typeof sample === "object" ? Object.keys(sample) : null;
            const sampleLabel = sample ? getVoteRowUnitLabel(sample, keyCandidates) : null;
            console.warn(
              `[TD HUB] La tabla "${votesTable}" tiene ${vr.length} filas pero ninguna coincidió con unidades cargadas.`,
              skippedNoName
                ? ` ${skippedNoName} filas sin nombre usable (todas las columnas de enlace vacías o null; revisa Nombre / nombre / unit_name o VITE_VOTES_KEY_COLUMN).`
                : " Revisa que el texto en la columna de nombre coincida con `nombre` o `nombre_en` en units (mismos caracteres tras normalizar espacios y mayúsculas).",
              "\nEjemplo primera fila — columnas:",
              sampleKeys,
              "\nNombre leído tras buscar en columnas de enlace:",
              sampleLabel,
              "\nPrimeras unidades (normalizado → nombre en units):",
              Object.entries(voteValuesByNorm).slice(0, 10),
            );
          }
        }
      }
    } catch (e) {
      console.warn(`[TD HUB] Error de red al leer "${votesTable}":`, e);
    }
  }

  if (!units_out.length) throw new Error("No hay unidades en la tabla.");

  return { units: units_out, vote_values };
}
