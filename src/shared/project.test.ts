import * as v from "valibot";
import { describe, expect, test } from "vite-plus/test";
import { MAX_PROJECT_URL_LENGTH, ProjectUrlSchema, projectUrlOf } from "./project";

const NORMALIZED: readonly (readonly [string, string])[] = [
  ["https://Example.com/app/?q=1#x", "https://example.com/app"],
  ["https://example.com/app?utm_source=x", "https://example.com/app"],
  ["https://example.com/app/", "https://example.com/app"],
  ["https://example.com/app//", "https://example.com/app"],
  ["https://example.com", "https://example.com"],
  ["https://example.com/", "https://example.com"],
  ["https://example.com:443/app", "https://example.com/app"],
  ["http://Example.com:8080/", "http://example.com:8080"],
  ["https://example.com/App", "https://example.com/App"],
  ["https://user:secret@example.com/a", "https://example.com/a"],
  ["  https://example.com/app  ", "https://example.com/app"],
];

const REJECTED: readonly (string | null)[] = [
  null,
  "",
  "   ",
  "example.com/app",
  "/app",
  "//example.com/app",
  "ftp://x/",
  "https://",
  "not a url",
];

describe("projectUrlOf", () => {
  for (const [raw, url] of NORMALIZED) {
    test(`normalizes ${raw}`, () => {
      expect(projectUrlOf(raw)).toBe(url);
      expect(projectUrlOf(url)).toBe(url);
    });
  }

  for (const raw of REJECTED) {
    test(`rejects ${String(raw)}`, () => {
      expect(projectUrlOf(raw)).toBeNull();
    });
  }

  test("refuses a value that percent-encodes past the cap", () => {
    const raw = "https://example.com/" + "é".repeat(340);

    expect(raw.length).toBeLessThanOrEqual(MAX_PROJECT_URL_LENGTH);
    expect(projectUrlOf(raw)).toBeNull();
  });

  test("accepts a url at the cap and refuses one character more", () => {
    const root = "https://example.com/";
    const room = MAX_PROJECT_URL_LENGTH - root.length;

    expect(projectUrlOf(root + "a".repeat(room))).not.toBeNull();
    expect(projectUrlOf(root + "a".repeat(room + 1))).toBeNull();
  });
});

describe("ProjectUrlSchema", () => {
  test("accepts a url that normalizes to something shorter", () => {
    expect(v.parse(ProjectUrlSchema, "https://Example.com/app/")).toBe("https://Example.com/app/");
  });

  test("rejects a value that is not a web url", () => {
    expect(v.safeParse(ProjectUrlSchema, "not-a-url").success).toBe(false);
    expect(v.safeParse(ProjectUrlSchema, "ftp://x/").success).toBe(false);
  });
});
