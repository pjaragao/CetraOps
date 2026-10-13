/**
 * HTML vindo de fora (guia de tamanho do site da marca) só é exibido depois de passar por aqui: fica só texto, tabela e formatação simples.
 * Sai: script, style, iframe, comentários, eventos (onclick…), links e qualquer atributo que não seja colspan/rowspan.
 */
const ALLOWED = new Set(["p", "br", "strong", "b", "em", "i", "u", "span", "table", "thead", "tbody", "tfoot", "tr", "td", "th", "ul", "ol", "li", "h1", "h2", "h3", "h4", "small"]);

export function sanitizeHtml(input: string): string {
  let s = String(input ?? "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<(script|style|iframe|object|embed|noscript|template|svg|math)\b[\s\S]*?<\/\1\s*>/gi, "");
  s = s.replace(/<(script|style|iframe|object|embed|noscript|template|svg|math)\b[^>]*\/?>/gi, "");
  return s.replace(/<\s*(\/?)\s*([a-zA-Z0-9]+)([^>]*)>/g, (_, close: string, tag: string, attrs: string) => {
    const t = tag.toLowerCase();
    if (!ALLOWED.has(t)) return "";
    if (close) return `</${t}>`;
    const keep: string[] = [];
    for (const m of attrs.matchAll(/\b(colspan|rowspan)\s*=\s*["']?(\d{1,2})["']?/gi)) keep.push(`${m[1].toLowerCase()}="${m[2]}"`);
    return `<${t}${keep.length ? " " + keep.join(" ") : ""}>`;
  });
}

/**
 * Foto do catálogo para mostrar: caminho no bucket público `catalog-media` (cópia guardada; miniatura pelo imgproxy do Storage)
 * ou o link do site, enquanto a cópia não foi feita.
 */
export function catalogPhoto(pathOrUrl: string, width: number | null, supabaseUrl: string): string {
  if (/^https?:\/\//.test(pathOrUrl)) return width ? cdnImage(pathOrUrl, width) : pathOrUrl;
  const base = supabaseUrl.replace(/\/+$/, "");
  const path = pathOrUrl.split("/").map(encodeURIComponent).join("/");
  return width ? `${base}/storage/v1/render/image/public/catalog-media/${path}?width=${width}&resize=contain&quality=80`
               : `${base}/storage/v1/object/public/catalog-media/${path}`;
}

/** URL de imagem do CDN da Shopify num tamanho menor (o próprio CDN redimensiona). */
export function cdnImage(url: string, width: number): string {
  if (!/^https:\/\/cdn\.shopify\.com\//.test(url)) return url;
  return url + (url.includes("?") ? "&" : "?") + `width=${width}`;
}
