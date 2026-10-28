import { describe, expect, test } from "vitest";
import { formatRate } from "./format";

describe("formatRate", () => {
  test("keeps at most four decimals and drops trailing zeros", () => {
    expect(formatRate(0.1)).toBe("0.1");
    expect(formatRate(0.0031)).toBe("0.0031");
    expect(formatRate(0.5)).toBe("0.5");
    expect(formatRate(1.4)).toBe("1.4");
    expect(formatRate(15)).toBe("15");
    expect(formatRate(0)).toBe("0");
  });

  test("rounds a fifth decimal rather than truncating it", () => {
    expect(formatRate(0.00005)).toBe("0.0001");
    expect(formatRate(1.23456)).toBe("1.2346");
  });

  test("an unset tier reads as a dash", () => {
    expect(formatRate(null)).toBe("—");
  });

  test("carries no currency sign, which is an icon at the call site", () => {
    expect(formatRate(0.1)).not.toContain("$");
  });
});
