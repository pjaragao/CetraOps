/**
 * Código de barras Code 128 (conjunto B; troca para C em sequências de dígitos) para etiquetas de peças.
 * Gera as larguras das barras para desenhar em SVG, sem biblioteca externa. Lido pelo leitor USB e pela câmera do PDV/contagem.
 */
const PATTERNS = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213", "221312", "231212", "112232", "122132", "122231", "113222",
  "123122", "123221", "223211", "221132", "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211", "212123", "212321",
  "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313", "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121",
  "313121", "211331", "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111", "314111", "221411", "431111", "111224",
  "111422", "121124", "121421", "141122", "141221", "112214", "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141", "214121", "412121", "111143", "111341", "131141", "114113",
  "114311", "411113", "411311", "113141", "114131", "311141", "411131", "211412", "211214", "211232", "2331112",
];
const START_B = 104, START_C = 105, CODE_B = 100, CODE_C = 99, STOP = 106;

/** Valores (com o dígito verificador e o STOP) do texto em Code 128. Só ASCII 32–126. */
export function code128Values(text: string): number[] {
  if (!text || [...text].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) > 126)) throw new Error("Code 128: use só caracteres ASCII visíveis");
  const values: number[] = [];
  let set: "B" | "C" | null = null;
  let i = 0;
  const digitsAhead = (k: number) => { let n = 0; while (k + n < text.length && /\d/.test(text[k + n])) n++; return n; };
  while (i < text.length) {
    const run = digitsAhead(i);
    const useC = run >= 4 && (run % 2 === 0 || set === "C" || i + run === text.length || run >= 6);
    if (useC && run >= 2) {
      const len = run % 2 === 0 ? run : run - 1;
      if (set !== "C") { values.push(set === null ? START_C : CODE_C); set = "C"; }
      for (let k = 0; k < len; k += 2) values.push(Number(text.slice(i + k, i + k + 2)));
      i += len;
      continue;
    }
    if (set !== "B") { values.push(set === null ? START_B : CODE_B); set = "B"; }
    values.push(text.charCodeAt(i) - 32);
    i++;
  }
  const check = values.reduce((sum, v, idx) => sum + v * (idx === 0 ? 1 : idx), 0) % 103;
  return [...values, check, STOP];
}

/** Larguras alternadas (barra, espaço, barra…) em módulos, com a zona de silêncio de 10 módulos de cada lado. */
export function code128Bars(text: string): { widths: number[]; modules: number } {
  const widths = code128Values(text).flatMap((v) => PATTERNS[v].split("").map(Number));
  return { widths, modules: widths.reduce((a, b) => a + b, 0) + 20 };
}

/** SVG do código (só as barras). `height` em unidades do viewBox; a largura é o total de módulos. */
export function code128Svg(text: string, height = 40): string {
  const { widths, modules } = code128Bars(text);
  let x = 10;
  const rects: string[] = [];
  widths.forEach((w, idx) => {
    if (idx % 2 === 0) rects.push(`<rect x="${x}" y="0" width="${w}" height="${height}"/>`);
    x += w;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${modules} ${height}" preserveAspectRatio="none" shape-rendering="crispEdges"><rect width="${modules}" height="${height}" fill="#fff"/><g fill="#000">${rects.join("")}</g></svg>`;
}
