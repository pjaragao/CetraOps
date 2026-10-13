import { describe, expect, it } from "vitest";
import { catalogPhoto, cdnImage, sanitizeHtml } from "./html";

describe("sanitizeHtml", () => {
  it("mantém tabela e texto e tira script, eventos, estilos e links", () => {
    const dirty = `<p style="color:red" onclick="x()"><strong>TABELA</strong></p><script>alert(1)</script><table border="1"><tr><td colspan="2" style="a">P</td><td><a href="javascript:x">36</a></td></tr></table><img src=x onerror=alert(1)><!-- c -->`;
    expect(sanitizeHtml(dirty)).toBe(`<p><strong>TABELA</strong></p><table><tr><td colspan="2">P</td><td>36</td></tr></table>`);
  });
  it("não deixa passar tags disfarçadas", () => {
    expect(sanitizeHtml("<SCRIPT >x</SCRIPT ><svg><script>y</script></svg>ok")).toBe("ok");
  });
});

describe("cdnImage", () => {
  it("pede a imagem menor ao CDN da Shopify e deixa outras URLs como estão", () => {
    expect(cdnImage("https://cdn.shopify.com/s/files/a.jpg?v=1", 400)).toBe("https://cdn.shopify.com/s/files/a.jpg?v=1&width=400");
    expect(cdnImage("https://exemplo.com/a.jpg", 400)).toBe("https://exemplo.com/a.jpg");
  });
});

describe("catalogPhoto", () => {
  const base = "https://supa.test:8001/";
  it("foto já guardada no bucket: miniatura pelo Storage e original pelo caminho público", () => {
    expect(catalogPhoto("org/18320/020/abc.jpg", 240, base)).toBe("https://supa.test:8001/storage/v1/render/image/public/catalog-media/org/18320/020/abc.jpg?width=240&resize=contain&quality=80");
    expect(catalogPhoto("org/18320/020/abc.jpg", null, base)).toBe("https://supa.test:8001/storage/v1/object/public/catalog-media/org/18320/020/abc.jpg");
  });
  it("ainda só no site: usa o link (com tamanho do CDN)", () => {
    expect(catalogPhoto("https://cdn.shopify.com/a.jpg", 240, base)).toBe("https://cdn.shopify.com/a.jpg?width=240");
    expect(catalogPhoto("https://cdn.shopify.com/a.jpg", null, base)).toBe("https://cdn.shopify.com/a.jpg");
  });
});
