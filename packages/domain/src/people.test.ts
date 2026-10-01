import { describe, expect, it } from "vitest";
import { relativeLabel } from "./people";

describe("vínculos", () => {
  it("rótulo pelo gênero do parente", () => {
    expect(relativeLabel("PARENT", "F")).toBe("mãe");
    expect(relativeLabel("PARENT", "M")).toBe("pai");
    expect(relativeLabel("CHILD", null)).toBe("filho(a)");
    expect(relativeLabel("SPOUSE", "M")).toBe("marido");
    expect(relativeLabel("QUALQUER", "F")).toBe("pessoa próxima");
  });
});
