import { describe, expect, test } from "vite-plus/test";
import { createValueCatalog } from "./value-catalog";

const TTL_MS = 1_000;

function clock(start = 0) {
  let at = start;

  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

describe("createValueCatalog", () => {
  test("the first list reads and returns the values", () => {
    const time = clock();
    let reads = 0;

    const catalog = createValueCatalog(
      () => {
        reads += 1;

        return ["alpha"];
      },
      { ttlMs: TTL_MS, now: time.now },
    );

    expect(catalog.list("user-1")).toEqual(["alpha"]);
    expect(reads).toBe(1);
  });

  test("a second list inside the ttl serves the cached values", () => {
    const time = clock();
    let reads = 0;

    const catalog = createValueCatalog(
      () => {
        reads += 1;

        return ["alpha"];
      },
      { ttlMs: TTL_MS, now: time.now },
    );

    expect(catalog.list("user-1")).toEqual(["alpha"]);

    time.advance(TTL_MS - 1);

    expect(catalog.list("user-1")).toEqual(["alpha"]);
    expect(reads).toBe(1);
  });

  test("a list after the ttl reads again", () => {
    const time = clock();
    let values: readonly string[] = ["alpha"];
    let reads = 0;

    const catalog = createValueCatalog(
      () => {
        reads += 1;

        return values;
      },
      { ttlMs: TTL_MS, now: time.now },
    );

    expect(catalog.list("user-1")).toEqual(["alpha"]);

    values = ["beta", "alpha"];
    time.advance(TTL_MS);

    expect(catalog.list("user-1")).toEqual(["beta", "alpha"]);
    expect(reads).toBe(2);
  });

  test("two users are cached separately", () => {
    const time = clock();
    const reads: string[] = [];

    const catalog = createValueCatalog(
      (userId) => {
        reads.push(userId);

        return [userId + "-value"];
      },
      { ttlMs: TTL_MS, now: time.now },
    );

    expect(catalog.list("user-1")).toEqual(["user-1-value"]);
    expect(catalog.list("user-2")).toEqual(["user-2-value"]);
    expect(catalog.list("user-1")).toEqual(["user-1-value"]);
    expect(reads).toEqual(["user-1", "user-2"]);
  });
});
