import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { clientIp, corsHeaders, jsonResponse } from "../_shared/cors.ts";

const ALLOWED_IPS = (Deno.env.get("TESTER_ALLOWED_IPS") || "")
  .split(",")
  .map((ip) => ip.trim())
  .filter(Boolean);

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  if (!ALLOWED_IPS.length) {
    return jsonResponse({ allowed: false });
  }

  const ip = clientIp(req);
  return jsonResponse({ allowed: ALLOWED_IPS.includes(ip) });
});
