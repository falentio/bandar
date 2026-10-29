import { describe, expect, test } from "vite-plus/test";
import { MAX_SESSION_ID_LENGTH, sessionIdOf } from "./session-id";

describe("sessionIdOf", () => {
  test("keeps a printable ascii id as sent", () => {
    expect(sessionIdOf("abc-123")).toBe("abc-123");
  });

  test("drops the spaces around the id", () => {
    expect(sessionIdOf("  abc-123  ")).toBe("abc-123");
  });

  test("keeps the case of the id", () => {
    expect(sessionIdOf("AbC-123")).toBe("AbC-123");
  });

  test("accepts the longest id and refuses one character more", () => {
    const longest = "s".repeat(MAX_SESSION_ID_LENGTH);

    expect(sessionIdOf(longest)).toBe(longest);
    expect(sessionIdOf(longest + "s")).toBeNull();
  });

  test("accepts every punctuation character in the printable range", () => {
    const punctuation = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";

    expect(sessionIdOf(punctuation)).toBe(punctuation);
  });

  test("rejects an empty or blank value", () => {
    expect(sessionIdOf("")).toBeNull();
    expect(sessionIdOf("   ")).toBeNull();
  });

  test("rejects an id with an inner space", () => {
    expect(sessionIdOf("has space")).toBeNull();
  });

  test("rejects an id with a tab", () => {
    expect(sessionIdOf("tab\tid")).toBeNull();
  });

  test("rejects an id outside ascii", () => {
    expect(sessionIdOf("caf\u00e9")).toBeNull();
  });

  test("rejects a missing header", () => {
    expect(sessionIdOf(null)).toBeNull();
  });
});
