export function assetUrl(relativePath) {
  if (!relativePath || typeof relativePath !== "string") return "";
  const base = import.meta.env.BASE_URL || "/";
  const cleanBase = base.endsWith("/") ? base : `${base}/`;
  const rel = relativePath.replace(/^\/*/, "");
  return `${cleanBase}${rel}`;
}
