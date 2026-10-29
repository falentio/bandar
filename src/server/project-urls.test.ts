import { describe, expect, test } from "vite-plus/test";
import { createProjectUrlCatalog } from "./project-urls";

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

describe("createProjectUrlCatalog", () => {
  test("the first list reads and returns the urls", () => {
    const time = clock();
    let reads = 0;

    const catalog = createProjectUrlCatalog(
      () => {
        reads += 1;

        return ["https://acme.test/app"];
      },
      { ttlMs: TTL_MS, now: time.now },
    );

    expect(catalog.list("user-1")).toEqual(["https://acme.test/app"]);
    expect(reads).toBe(1);
  });

  test("a second list inside the ttl serves the cached urls", () => {
    const time = clock();
    let reads = 0;

    const catalog = createProjectUrlCatalog(
      () => {
        reads += 1;

        return ["https://acme.test/app"];
      },
      { ttlMs: TTL_MS, now: time.now },
    );

    expect(catalog.list("user-1")).toEqual(["https://acme.test/app"]);

    time.advance(TTL_MS - 1);

    expect(catalog.list("user-1")).toEqual(["https://acme.test/app"]);
    expect(reads).toBe(1);
  });

  test("a list after the ttl reads again", () => {
    const time = clock();
    let values: readonly string[] = ["https://acme.test/app"];
    let reads = 0;

    const catalog = createProjectUrlCatalog(
      () => {
        reads += 1;

        return values;
      },
      { ttlMs: TTL_MS, now: time.now },
    );

    expect(catalog.list("user-1")).toEqual(["https://acme.test/app"]);

    values = ["https://dash.acme.test", "https://acme.test/app"];
    time.advance(TTL_MS);

    expect(catalog.list("user-1")).toEqual(["https://dash.acme.test", "https://acme.test/app"]);
    expect(reads).toBe(2);
  });

  test("two users are cached separately", () => {
    const time = clock();
    const reads: string[] = [];

    const catalog = createProjectUrlCatalog(
      (userId) => {
        reads.push(userId);

        return [`https://${userId}.acme.test`];
      },
      { ttlMs: TTL_MS, now: time.now },
    );

    expect(catalog.list("user-1")).toEqual(["https://user-1.acme.test"]);
    expect(catalog.list("user-2")).toEqual(["https://user-2.acme.test"]);
    expect(catalog.list("user-1")).toEqual(["https://user-1.acme.test"]);
    expect(reads).toEqual(["user-1", "user-2"]);
  });
});
