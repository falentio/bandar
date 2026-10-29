import { describe, expect, test } from "vite-plus/test";
import * as v from "valibot";
import { createGateway, type GatewayDeps } from "./gateway";

// SAFETY: the schema rejections asserted here return before any handler reads a dep.
const gateway = createGateway({} as GatewayDeps);

const OpenAiErrorSchema = v.object({
  error: v.object({
    message: v.string(),
    type: v.string(),
    param: v.nullable(v.string()),
    code: v.string(),
  }),
});

const AnthropicErrorSchema = v.object({
  type: v.literal("error"),
  error: v.object({ type: v.string(), message: v.string() }),
});

async function post(path: string, body: string): Promise<Response> {
  return gateway.handle(
    new Request(`http://gateway.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }),
  );
}

describe("gateway schema rejections", () => {
  test("names the rejected top-level field", async () => {
    const response = await post(
      "/v1/chat/completions",
      JSON.stringify({
        model: "tags/deepseek",
        stop: 1,
        messages: [{ role: "user", content: "hello" }],
      }),
    );

    const body = v.parse(OpenAiErrorSchema, await response.json());

    expect(response.status).toBe(422);
    expect(body.error.param).toBe("stop");
    expect(body.error.message).toContain("stop");
  });

  test("names the rejected nested field", async () => {
    const response = await post(
      "/v1/chat/completions",
      JSON.stringify({ model: "tags/deepseek", messages: [{ role: "user", content: 1 }] }),
    );

    const body = v.parse(OpenAiErrorSchema, await response.json());

    expect(body.error.param).toBe("messages.0.content");
    expect(body.error.message).toContain("messages.0.content");
  });

  test("names the rejected field on the anthropic surface", async () => {
    const response = await post(
      "/v1/messages",
      JSON.stringify({
        model: "tags/deepseek",
        max_tokens: 16,
        stop_sequences: 1,
        messages: [{ role: "user", content: "hello" }],
      }),
    );

    const body = v.parse(AnthropicErrorSchema, await response.json());

    expect(body.error.message).toContain("stop_sequences");
  });
});
