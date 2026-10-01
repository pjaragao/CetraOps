import { describe, expect, it } from "vitest";
import { fmtHours, netMinutes, spanMinutes } from "./schedule";

describe("horas da escala", () => {
  it("jornada líquida desconta o intervalo", () => {
    expect(netMinutes("06:45", "15:00", 60)).toBe(435);
    expect(fmtHours(435)).toBe("7h15");
    expect(fmtHours(480)).toBe("8h");
  });
  it("vira a meia-noite", () => {
    expect(spanMinutes("22:00", "02:00")).toBe(240);
    expect(netMinutes("22:00", "02:00", 0)).toBe(240);
  });
  it("sem horário ou início igual ao fim é zero", () => {
    expect(netMinutes(null, "10:00", 0)).toBe(0);
    expect(netMinutes("10:00", "10:00", 0)).toBe(0);
  });
});
