import { describe, expect, test } from "vite-plus/test";
import {
  MAX_CAPTURE_CHARS,
  currentCapture,
  exchangeOf,
  inCapture,
  newCapture,
  noteRequest,
  noteResponse,
} from "./exchange";

describe("exchange capture", () => {
  test("records the request and the response the caller read", async () => {
    const capture = newCapture();

    await inCapture(capture, async () => {
      const active = currentCapture();

      expect(active).toBe(capture);

      noteRequest(capture, "https://upstream.test/v1/chat/completions", {}, '{"model":"m"}');
      noteResponse(capture, new Response("ok"), new Blob(['{"choices":[]}']).stream());
    });

    const exchange = await exchangeOf(capture);

    expect(exchange?.requestUrl).toBe("https://upstream.test/v1/chat/completions");
    expect(exchange?.responseStatus).toBe(200);
    expect(exchange?.responseBody).toBe('{"choices":[]}');
    expect(exchange?.truncated).toBe(false);
  });

  test("masks credential headers and keeps the rest", async () => {
    const capture = newCapture();

    noteRequest(
      capture,
      "https://upstream.test/v1",
      {
        authorization: "Bearer sk-live-secret",
        "x-api-key": "sk-anthropic",
        "content-type": "application/json",
      },
      "{}",
    );

    const headers = JSON.parse((await exchangeOf(capture))?.requestHeaders ?? "{}");

    expect(headers.authorization).toBe("Bearer ••••");
    expect(headers["x-api-key"]).toBe("••••");
    expect(headers["content-type"]).toBe("application/json");
  });

  test("caps an oversized request body and marks the exchange truncated", async () => {
    const capture = newCapture();

    noteRequest(capture, "https://upstream.test/v1", {}, "x".repeat(MAX_CAPTURE_CHARS + 10));

    const exchange = await exchangeOf(capture);

    expect(exchange?.requestBody).toHaveLength(MAX_CAPTURE_CHARS);
    expect(exchange?.truncated).toBe(true);
  });

  test("caps an oversized response body", async () => {
    const capture = newCapture();
    const chunk = new Uint8Array(MAX_CAPTURE_CHARS);

    noteRequest(capture, "https://upstream.test/v1", {}, "{}");
    noteResponse(capture, new Response("big"), new Blob([chunk, chunk]).stream());

    const exchange = await exchangeOf(capture);

    expect(exchange?.responseBody).toHaveLength(MAX_CAPTURE_CHARS);
    expect(exchange?.truncated).toBe(true);
  });

  test("an attempt that never reached upstream records no exchange", async () => {
    const capture = newCapture();

    await inCapture(capture, async () => undefined);

    expect(await exchangeOf(capture)).toBeNull();
  });

  test("concurrent attempts keep their own captures", async () => {
    const first = newCapture();
    const second = newCapture();

    await Promise.all([
      inCapture(first, async () => {
        await Promise.resolve();
        noteRequest(first, "https://first.test", {}, "1");
      }),
      inCapture(second, async () => {
        await Promise.resolve();
        noteRequest(second, "https://second.test", {}, "2");
      }),
    ]);

    expect((await exchangeOf(first))?.requestUrl).toBe("https://first.test");
    expect((await exchangeOf(second))?.requestUrl).toBe("https://second.test");
  });
});
