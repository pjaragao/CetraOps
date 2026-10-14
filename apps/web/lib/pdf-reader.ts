"use client";
import type { PdfTextItem } from "@centralops/domain";

/** Foto tirada do PDF, já reduzida e em JPEG, com o resumo SHA-256 (evita guardar a mesma foto duas vezes). */
export interface PdfPhoto { page: number; blob: Blob; url: string; width: number; height: number; hash: string }
export interface PdfContent { pages: PdfTextItem[][]; photos: PdfPhoto[] }

const MAX_SIDE = 1600;        // mesmo limite das fotos copiadas do site
const MIN_SIDE = 400;         // menor que isso é logo/ícone, não foto de produto

type PdfJs = typeof import("pdfjs-dist");
let lib: Promise<PdfJs> | null = null;
function pdfjs(): Promise<PdfJs> {
  lib ??= import("pdfjs-dist").then((m) => {
    // o bundler empacota o worker por este padrão (new Worker(new URL(...))); um só worker serve a todos os arquivos
    m.GlobalWorkerOptions.workerPort ??= new Worker(new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url), { type: "module" });
    return m;
  });
  return lib;
}

async function sha(blob: Blob): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 20);
}

type ImgObj = { bitmap?: ImageBitmap; data?: Uint8ClampedArray; width: number; height: number; kind?: number };

/** Objeto de imagem do pdf.js → canvas reduzido → JPEG. */
async function toJpeg(img: ImgObj): Promise<{ blob: Blob; width: number; height: number } | null> {
  const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
  const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  if (img.bitmap) ctx.drawImage(img.bitmap, 0, 0, w, h);
  else if (img.data) {
    const full = document.createElement("canvas");
    full.width = img.width; full.height = img.height;
    const fctx = full.getContext("2d")!;
    const px = img.width * img.height;
    let rgba = img.data;
    if (img.data.length === px * 3) {                     // RGB → RGBA
      rgba = new Uint8ClampedArray(px * 4);
      for (let i = 0, j = 0; i < px; i++, j += 3) { rgba[i * 4] = img.data[j]; rgba[i * 4 + 1] = img.data[j + 1]; rgba[i * 4 + 2] = img.data[j + 2]; rgba[i * 4 + 3] = 255; }
    } else if (img.data.length !== px * 4) return null;   // 1 bit por pixel (máscaras): não é foto
    fctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), img.width, img.height), 0, 0);
    ctx.drawImage(full, 0, 0, w, h);
  } else return null;
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", 0.86));
  return blob ? { blob, width: w, height: h } : null;
}

function getObj(page: { objs: { get: (id: string, cb: (o: unknown) => void) => void }; commonObjs: { get: (id: string, cb: (o: unknown) => void) => void } }, id: string): Promise<ImgObj | null> {
  const store = id.startsWith("g_") ? page.commonObjs : page.objs;
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 8000);
    try { store.get(id, (o) => { clearTimeout(t); resolve((o as ImgObj) ?? null); }); } catch { clearTimeout(t); resolve(null); }
  });
}

/**
 * Lê o PDF no navegador (o arquivo não sobe para o servidor): texto com posição de cada página e, se pedido, as fotos embutidas
 * nas páginas que `photos(página, texto)` aceitar (ex.: só as páginas de produto do catálogo).
 */
export async function readPdf(file: File, opts: { photos?: (page: number, text: PdfTextItem[]) => boolean; onProgress?: (done: number, total: number) => void; onPhotos?: (page: number, total: number) => void } = {}): Promise<PdfContent> {
  const m = await pdfjs();
  const doc = await m.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages: PdfTextItem[][] = [];
  const photos: PdfPhoto[] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const tc = await page.getTextContent();
      pages.push(tc.items.flatMap((it) => ("str" in it && it.str.trim() !== ""
        ? [{ s: it.str, x: it.transform[4], y: it.transform[5], w: it.width, h: it.height }] : [])));
      opts.onProgress?.(n, doc.numPages);
    }
    if (opts.photos) {
      for (let n = 1; n <= doc.numPages; n++) {
        if (!opts.photos(n, pages[n - 1] ?? [])) continue;
        opts.onPhotos?.(n, doc.numPages);
        const page = await doc.getPage(n);
        const ops = await page.getOperatorList();
        const ids = new Set<string>();
        ops.fnArray.forEach((fn, i) => { if (fn === m.OPS.paintImageXObject) ids.add(String(ops.argsArray[i][0])); });
        const seen = new Set(photos.filter((p) => p.page === n).map((p) => p.hash));
        for (const id of ids) {
          const obj = await getObj(page as never, id);
          if (!obj || Math.min(obj.width, obj.height) < MIN_SIDE) continue;
          const jpg = await toJpeg(obj);
          if (!jpg) continue;
          const hash = await sha(jpg.blob);
          if (seen.has(hash)) continue;
          seen.add(hash);
          photos.push({ page: n, ...jpg, hash, url: URL.createObjectURL(jpg.blob) });
        }
        page.cleanup();
      }
    }
  } finally {
    await doc.destroy();
  }
  return { pages, photos };
}
