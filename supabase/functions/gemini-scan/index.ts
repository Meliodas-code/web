import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { clientIp, corsHeaders, jsonResponse } from "../_shared/cors.ts";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") || "";
const ALLOWED_IPS = (Deno.env.get("TESTER_ALLOWED_IPS") || "")
  .split(",")
  .map((ip) => ip.trim())
  .filter(Boolean);

type ScanBody = {
  image?: string;
  namesList?: string[];
  maxCount?: number;
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  if (!GEMINI_API_KEY) {
    return jsonResponse({ error: "Scanner no configurado en el servidor." }, 503);
  }

  if (ALLOWED_IPS.length) {
    const ip = clientIp(req);
    if (!ALLOWED_IPS.includes(ip)) {
      return jsonResponse({ error: "Acceso denegado." }, 403);
    }
  }

  let body: ScanBody;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "JSON inválido." }, 400);
  }

  const image = String(body.image || "");
  const namesList = Array.isArray(body.namesList)
    ? body.namesList.filter(Boolean).map(String)
    : [];
  const imageData = image.includes(",") ? image.split(",")[1] : image;

  if (!imageData) {
    return jsonResponse({ error: "Imagen requerida." }, 400);
  }

  const namesJoined = namesList.join(", ");
  const prompt = `ACTÚA COMO UN EXPERTO EN RECONOCIMIENTO VISUAL.
TU TAREA: Escanear las cartas de personajes en la imagen adjunta.

REGLAS CRÍTICAS:
1. SOLO identifica unidades que estén EN LA IMAGEN.
2. Compara el físico (pelo, ropa, postura) con esta lista: [${namesJoined}]
3. Si hay varias unidades iguales, cuéntalas todas (qty).
4. VOTOS (Icono circular): Identifícalo por color (Rojo, Azul, Verde, etc.) y asígnale el ID "votoX" correspondiente.

RESPUESTA (SOLO JSON):
{"found": [{"name": "Nombre exacto", "vote": "votoX", "qty": 1}]}`;

  const geminiUrl =
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${GEMINI_API_KEY}`;

  const geminiRes = await fetch(geminiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            {
              inlineData: {
                mimeType: "image/png",
                data: imageData,
              },
            },
            { text: prompt },
          ],
        },
      ],
      generationConfig: {
        maxOutputTokens: 2048,
        temperature: 0,
        responseMimeType: "application/json",
      },
    }),
  });

  const geminiData = await geminiRes.json().catch(() => ({}));

  if (!geminiRes.ok) {
    const msg =
      geminiData?.error?.message ||
      `Gemini API error (${geminiRes.status})`;
    return jsonResponse({ error: msg }, 502);
  }

  const text =
    geminiData?.candidates?.[0]?.content?.parts
      ?.map((p: { text?: string }) => p.text || "")
      .join("")
      .trim() || "";

  if (!text) {
    return jsonResponse({ error: "Gemini no devolvió texto." }, 502);
  }

  return jsonResponse({ text });
});
