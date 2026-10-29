import { describe, expect, test } from "vite-plus/test";
import { zroEntries } from "./catalog";

describe("zro catalog", () => {
  test("a model listed bare and prefixed imports once, under its bare id", () => {
    const entries = zroEntries(["zro/glm-5.3-flash", "glm-5.3-flash"]);

    expect(entries).toEqual([
      {
        upstreamModel: "glm-5.3-flash",
        label: "glm-5.3-flash",
        inputPricePerMtok: 0.15,
        cacheInputPricePerMtok: 0.04,
        outputPricePerMtok: 0.5,
        contextWindow: null,
        maxOutput: null,
        inputModalities: null,
      },
    ]);
  });

  test("the fold does not depend on which of the two the list names first", () => {
    expect(zroEntries(["glm-5.3-flash", "zro/glm-5.3-flash"])).toEqual(
      zroEntries(["zro/glm-5.3-flash", "glm-5.3-flash"]),
    );
  });

  test("a prefix-only id imports as listed, priced from its bare row", () => {
    const [entry] = zroEntries(["zro/glm-5.3"]);

    expect(entry?.upstreamModel).toBe("zro/glm-5.3");
    expect(entry?.label).toBe("zro/glm-5.3");
    expect(entry?.inputPricePerMtok).toBe(1.4);
    expect(entry?.cacheInputPricePerMtok).toBe(0.3);
    expect(entry?.outputPricePerMtok).toBe(4.2);
  });

  test("an id the price table does not know imports unpriced", () => {
    const [entry] = zroEntries(["zro-newcomer"]);

    expect(entry?.upstreamModel).toBe("zro-newcomer");
    expect(entry?.inputPricePerMtok).toBeNull();
    expect(entry?.cacheInputPricePerMtok).toBeNull();
    expect(entry?.outputPricePerMtok).toBeNull();
  });

  test("a tabled id the list omits never imports, and a repeat imports once", () => {
    const entries = zroEntries(["minimax-m3.1-flash", "minimax-m3.1-flash"]);

    expect(entries.map((entry) => entry.upstreamModel)).toEqual(["minimax-m3.1-flash"]);
    expect(entries.some((entry) => entry.upstreamModel === "dolly2-security")).toBe(false);
  });
});
