const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || "";

/**
 * Llama a una Supabase Edge Function. Las claves secretas (Gemini, IPs) viven
 * solo en el servidor — el cliente solo usa la anon key pública.
 */
export async function callEdgeFunction(fnName, { method = "POST", body } = {}) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error("Faltan VITE_SUPABASE_URL o VITE_SUPABASE_ANON_KEY.");
  }

  const url = `${SUPABASE_URL}/functions/v1/${fnName}`;
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      apikey: SUPABASE_ANON_KEY,
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });

  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }

  if (!res.ok) {
    throw new Error(data.error || `Edge function ${fnName}: ${res.status}`);
  }

  return data;
}

export function edgeFunctionsConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}
