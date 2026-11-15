import { afterEach, describe, expect, test } from "vite-plus/test";
import { MAX_IMAGE_BYTES } from "../../shared/media";
import { IMAGE_FETCH_TIMEOUT_MS, fetchImage, readImage, type ResolvedAddress } from "./fetch";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==",
  "base64",
);

const LOOPBACK: readonly ResolvedAddress[] = [{ address: "127.0.0.1", family: 4 }];

let cleanup: (() => void)[] = [];

afterEach(() => {
  for (const stop of cleanup) stop();

  cleanup = [];
});

function serve(handler: (request: Request) => Response | Promise<Response>): string {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });

  cleanup.push(() => void server.stop(true));

  return `http://127.0.0.1:${String(server.port)}`;
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe("readImage", () => {
  test("reads a png and names it by its magic bytes, not its content type", async () => {
    const origin = serve(() => new Response(PNG, { headers: { "content-type": "text/html" } }));
    const result = await readImage(`${origin}/a.png`, LOOPBACK, signal());

    expect(result.ok).toBe(true);

    if (!result.ok) return;

    expect(result.value.mediaType).toBe("image/png");
    expect(result.value.bytes).toBe(PNG.length);
    expect(Buffer.from(result.value.data, "base64")).toEqual(PNG);
  });

  test("refuses a redirect instead of following it", async () => {
    const origin = serve(
      () => new Response(null, { status: 302, headers: { location: "/a.png" } }),
    );

    expect(await readImage(`${origin}/redirect`, LOOPBACK, signal())).toMatchObject({
      ok: false,
      rejection: {
        status: 422,
        message: "the image url answered with a redirect, which this gateway does not follow",
      },
    });
  });

  test("refuses a body over the cap without trusting the declared length", async () => {
    const origin = serve(() => new Response(new Uint8Array(MAX_IMAGE_BYTES + 1)));

    expect(await readImage(`${origin}/big.png`, LOOPBACK, signal())).toMatchObject({
      ok: false,
      rejection: { message: "the image is over the 5242880 byte limit" },
    });
  });

  test("refuses html behind a .png url", async () => {
    const origin = serve(
      () => new Response("<html>not an image</html>", { headers: { "content-type": "image/png" } }),
    );

    expect(await readImage(`${origin}/a.png`, LOOPBACK, signal())).toMatchObject({
      ok: false,
      rejection: { message: "the data is not a png, jpeg, gif, or webp image" },
    });
  });

  test(
    "fires its timeout when the server never answers",
    async () => {
      const origin = serve(() => new Promise<Response>(() => undefined));
      const started = performance.now();
      const result = await readImage(`${origin}/slow.png`, LOOPBACK, signal());

      expect(result).toMatchObject({
        ok: false,
        rejection: {
          message: `the image did not answer within ${String(IMAGE_FETCH_TIMEOUT_MS)} ms`,
        },
      });
      expect(performance.now() - started).toBeLessThan(IMAGE_FETCH_TIMEOUT_MS + 2_000);
    },
    IMAGE_FETCH_TIMEOUT_MS + 5_000,
  );

  test("stops when the caller's signal aborts", async () => {
    const origin = serve(() => new Promise<Response>(() => undefined));
    const controller = new AbortController();
    const pending = readImage(`${origin}/slow.png`, LOOPBACK, controller.signal);

    controller.abort();

    expect(await pending).toMatchObject({
      ok: false,
      rejection: { message: "the request was aborted" },
    });
  });
});

describe("fetchImage", () => {
  test("refuses a loopback address before it connects", async () => {
    const origin = serve(() => new Response(PNG));

    expect(await fetchImage(`${origin}/a.png`, signal())).toMatchObject({
      ok: false,
      rejection: {
        message: `the image url resolves to 127.0.0.1, a private address this gateway will not reach`,
      },
    });
  });

  test("refuses a private literal, and a scheme that is not http", async () => {
    expect(await fetchImage("http://10.0.0.1/a.png", signal())).toMatchObject({
      ok: false,
      rejection: {
        message:
          "the image url resolves to 10.0.0.1, a private address this gateway will not reach",
      },
    });
    expect(await fetchImage("http://[::1]/a.png", signal())).toMatchObject({ ok: false });
    expect(await fetchImage("http://[::ffff:127.0.0.1]/a.png", signal())).toMatchObject({
      ok: false,
      rejection: { status: 422 },
    });
    expect(await fetchImage("file:///etc/passwd", signal())).toMatchObject({
      ok: false,
      rejection: { message: "the image url is not http or https" },
    });
    expect(await fetchImage("https://169.254.169.254/latest/meta-data", signal())).toMatchObject({
      ok: false,
      rejection: {
        message: `the image url resolves to 169.254.169.254, a private address this gateway will not reach`,
      },
    });
  });
});
