import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vite-plus/test";
import * as v from "valibot";
import { addProviderCredential } from "../credentials";
import { user } from "../db/auth-schema";
import { openDatabase } from "../db/client";
import { applyMigrations, type Migration } from "../db/migrate";
import { DuckDb } from "../duck/client";
import { applyDuckMigrations } from "../duck/migrate";
import { addProviderModel, createProvider, updateProviderModel, type ProviderDeps } from "../providers";
import { DEFAULT_PROVIDER_ENDPOINTS } from "../providers/endpoints";
import { createSealer } from "../seal";
import { createGateway } from "../gateway";
import type { Auth } from "../auth";
import type { Compat } from "../../shared/providers";
import type { ToolCall, ToolResult } from "../../shared/conversation";

const SQLITE_DIR = fileURLToPath(new URL("../../../drizzle", import.meta.url));
const DUCK_DIR = fileURLToPath(new URL("../../../duckdb", import.meta.url));
const DUCK_LIB = fileURLToPath(new URL("../../../vendor/duckdb/libduckdb.so", import.meta.url));

const READ_FILE = {
  type: "function",
  function: {
    name: "read_file",
    description: "read one file",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
};

const ARGUMENTS = '{"path":"./src"}';

const CallSchema = v.object({
  id: v.string(),
  type: v.string(),
  function: v.object({ name: v.string(), arguments: v.string() }),
});

const ChatReplySchema = v.object({
  choices: v.array(
    v.object({
      message: v.object({
        role: v.string(),
        content: v.nullable(v.string()),
        tool_calls: v.optional(v.array(CallSchema)),
      }),
      finish_reason: v.string(),
    }),
  ),
});

const ChatIngressSchema = v.object({
  type: v.literal("message"),
  content: v.array(
    v.object({
      type: v.string(),
      text: v.optional(v.string()),
      id: v.optional(v.string()),
      name: v.optional(v.string()),
      input: v.optional(v.unknown()),
    }),
  ),
  stop_reason: v.string(),
});

const StreamChunkSchema = v.object({
  choices: v.array(
    v.object({
      delta: v.object({
        tool_calls: v.optional(
          v.array(
            v.object({
              index: v.number(),
              id: v.optional(v.string()),
              function: v.optional(
                v.object({
                  name: v.optional(v.string()),
                  arguments: v.optional(v.string()),
                }),
              ),
            }),
          ),
        ),
      }),
      finish_reason: v.nullable(v.string()),
    }),
  ),
});

const BlockStartSchema = v.object({
  index: v.number(),
  content_block: v.object({
    type: v.string(),
    text: v.optional(v.string()),
    id: v.optional(v.string()),
    name: v.optional(v.string()),
    input: v.optional(v.unknown()),
  }),
});

const BlockDeltaSchema = v.object({
  index: v.number(),
  delta: v.object({ type: v.string(), partial_json: v.optional(v.string()) }),
});

const StopSchema = v.object({ index: v.number() });

const MessageDeltaSchema = v.object({
  delta: v.object({ stop_reason: v.nullable(v.string()) }),
});

type Call = {
  readonly path: string;
  readonly headers: Headers;
  readonly body: unknown;
};

type Upstream = { readonly origin: string; readonly calls: Call[] };

type Harness = {
  readonly gateway: ReturnType<typeof createGateway>;
  readonly upstream: Upstream;
};

let cleanup: (() => void)[] = [];

afterEach(() => {
  for (const stop of cleanup) stop();
  cleanup = [];
});

describe("the chat wire", () => {
  test("sends the definitions, answers the call, and carries the result back", async () => {
    const harness = await harnessOn("openai", (call) => {
      // SAFETY: the fake upstream records the JSON body the adapter posted.
      const body = call.body as { messages: { role: string }[] };

      return body.messages.some((message) => message.role === "tool")
        ? json({ choices: [{ message: { role: "assistant", content: "a list" }, finish_reason: "stop" }] })
        : json({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: ARGUMENTS } }],
                },
                finish_reason: "tool_calls",
              },
            ],
          });
    });

    const first = await postChat(harness.gateway, {
      model: "fast",
      messages: [{ role: "user", content: "what is in ./src?" }],
      tools: [READ_FILE],
      tool_choice: "required",
    });

    expect(first.status).toBe(200);

    const answer = v.parse(ChatReplySchema, await first.json());
    const call = answer.choices[0]?.message.tool_calls?.[0];

    expect(answer.choices[0]?.finish_reason).toBe("tool_calls");
    expect(call).toEqual({
      id: "call_1",
      type: "function",
      function: { name: "read_file", arguments: ARGUMENTS },
    });

    expect(harness.upstream.calls[0]?.body).toMatchObject({
      tools: [
        {
          type: "function",
          function: { name: "read_file", description: "read one file", parameters: { type: "object" } },
        },
      ],
      tool_choice: "required",
    });

    const second = await postChat(harness.gateway, {
      model: "fast",
      messages: [
        { role: "user", content: "what is in ./src?" },
        { role: "assistant", content: null, tool_calls: [call] },
        { role: "tool", tool_call_id: "call_1", content: "chat.ts\nmessages.ts" },
      ],
      tools: [READ_FILE],
    });

    expect(second.status).toBe(200);
    expect(harness.upstream.calls[1]?.body).toMatchObject({
      messages: [
        { role: "user", content: "what is in ./src?" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: ARGUMENTS } }],
        },
        { role: "tool", tool_call_id: "call_1", content: "chat.ts\nmessages.ts" },
      ],
    });
  });

  test("keeps length on a truncated call instead of calling it a tool turn", async () => {
    const harness = await harnessOn("openai", () =>
      json({
        choices: [
          {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":' } }],
            },
            finish_reason: "length",
          },
        ],
      }),
    );

    const response = await postChat(harness.gateway, {
      model: "fast",
      messages: [{ role: "user", content: "read it" }],
      tools: [READ_FILE],
    });

    const answer = v.parse(ChatReplySchema, await response.json());

    expect(answer.choices[0]?.finish_reason).toBe("length");
    expect(answer.choices[0]?.message.tool_calls).toHaveLength(1);
  });
});

describe("the responses wire", () => {
  test("sends flat definitions, answers a function call, and carries its output back", async () => {
    const harness = await harnessOn(
      "openai",
      (call) => {
        // SAFETY: the fake upstream records the JSON body the adapter posted.
        const body = call.body as { input: { type?: string }[] };

        return body.input.some((item) => item.type === "function_call_output")
          ? json({
              output: [{ type: "message", content: [{ type: "output_text", text: "a list" }] }],
              status: "completed",
            })
          : json({
              output: [
                { type: "function_call", call_id: "call_9", name: "read_file", arguments: ARGUMENTS },
              ],
              status: "completed",
            });
      },
      "responses",
    );

    const first = await postChat(harness.gateway, {
      model: "fast",
      messages: [{ role: "user", content: "what is in ./src?" }],
      tools: [READ_FILE],
    });

    const answer = v.parse(ChatReplySchema, await first.json());

    expect(answer.choices[0]?.finish_reason).toBe("tool_calls");
    expect(answer.choices[0]?.message.tool_calls?.[0]?.id).toBe("call_9");

    expect(harness.upstream.calls[0]?.body).toMatchObject({
      tools: [{ type: "function", name: "read_file", parameters: { type: "object" } }],
    });

    await postChat(harness.gateway, {
      model: "fast",
      messages: [
        { role: "user", content: "what is in ./src?" },
        { role: "assistant", content: "", tool_calls: [answer.choices[0]?.message.tool_calls?.[0]] },
        { role: "tool", tool_call_id: "call_9", content: "a list" },
      ],
      tools: [READ_FILE],
    });

    expect(harness.upstream.calls[1]?.body).toMatchObject({
      input: [
        { role: "user", content: [{ type: "input_text", text: "what is in ./src?" }] },
        { type: "function_call", call_id: "call_9", name: "read_file", arguments: ARGUMENTS },
        { type: "function_call_output", call_id: "call_9", output: "a list" },
      ],
    });
  });
});

describe("the messages wire", () => {
  test("sends the definitions, answers tool_use, and carries the result block back", async () => {
    const harness = await harnessOn("anthropic", (call) => {
      // SAFETY: the fake upstream records the JSON body the adapter posted.
      const body = call.body as { messages: { content: unknown }[] };
      const answered = body.messages.some(
        (message) => JSON.stringify(message.content).includes("tool_result"),
      );

      return answered
        ? json({ content: [{ type: "text", text: "a list" }], stop_reason: "end_turn" })
        : json({
            content: [{ type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "./src" } }],
            stop_reason: "tool_use",
          });
    });

    const first = await postMessages(harness.gateway, {
      model: "fast",
      max_tokens: 64,
      messages: [{ role: "user", content: "what is in ./src?" }],
      tools: [{ name: "read_file", description: "read one file", input_schema: { type: "object" } }],
      tool_choice: { type: "auto" },
    });

    expect(first.status).toBe(200);

    const answer = v.parse(ChatIngressSchema, await first.json());
    const block = answer.content.find((entry) => entry.type === "tool_use");

    expect(answer.stop_reason).toBe("tool_use");
    expect(block).toMatchObject({ id: "toolu_1", name: "read_file", input: { path: "./src" } });

    expect(harness.upstream.calls[0]?.body).toMatchObject({
      tools: [{ name: "read_file", description: "read one file", input_schema: { type: "object" } }],
      tool_choice: { type: "auto" },
    });

    const second = await postMessages(harness.gateway, {
      model: "fast",
      max_tokens: 64,
      messages: [
        { role: "user", content: "what is in ./src?" },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "./src" } }] },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "a list" }],
        },
      ],
    });

    expect(second.status).toBe(200);
    expect(harness.upstream.calls[1]?.body).toMatchObject({
      messages: [
        { role: "user", content: "what is in ./src?" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "./src" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "a list" }],
        },
      ],
    });
  });
});

describe("the genai wire", () => {
  test("sends declarations, mints a call id, and answers by function name", async () => {
    const harness = await harnessOn("google", (call) => {
      // SAFETY: the fake upstream records the JSON body the adapter posted.
      const body = call.body as { contents: { parts: unknown[] }[] };
      const answered = body.contents.some((turn) =>
        JSON.stringify(turn.parts).includes("functionResponse"),
      );

      return answered
        ? json({
            candidates: [
              { content: { parts: [{ text: "a list" }] }, finishReason: "STOP" },
            ],
          })
        : json({
            candidates: [
              {
                content: { parts: [{ functionCall: { name: "read_file", args: { path: "./src" } } }] },
                finishReason: "STOP",
              },
            ],
          });
    });

    const first = await postChat(harness.gateway, {
      model: "fast",
      messages: [{ role: "user", content: "what is in ./src?" }],
      tools: [READ_FILE],
      tool_choice: "required",
    });

    const answer = v.parse(ChatReplySchema, await first.json());
    const call = answer.choices[0]?.message.tool_calls?.[0];

    expect(answer.choices[0]?.finish_reason).toBe("tool_calls");
    expect(call?.function).toEqual({ name: "read_file", arguments: ARGUMENTS });

    expect(harness.upstream.calls[0]?.body).toMatchObject({
      tools: [{ functionDeclarations: [{ name: "read_file", parameters: { type: "object" } }] }],
      toolConfig: { functionCallingConfig: { mode: "ANY" } },
    });

    await postChat(harness.gateway, {
      model: "fast",
      messages: [
        { role: "user", content: "what is in ./src?" },
        { role: "assistant", content: "", tool_calls: [call] },
        { role: "tool", tool_call_id: call?.id, content: "a list" },
      ],
      tools: [READ_FILE],
    });

    expect(harness.upstream.calls[1]?.body).toMatchObject({
      contents: [
        { role: "user", parts: [{ text: "what is in ./src?" }] },
        { role: "model", parts: [{ functionCall: { name: "read_file", args: { path: "./src" } } }] },
        {
          role: "user",
          parts: [{ functionResponse: { name: "read_file", response: { result: "a list" } } }],
        },
      ],
    });
  });
});

describe("streaming tool calls", () => {
  const fragments = [
    { choices: [{ delta: { role: "assistant" } }] },
    {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: "" } }],
          },
        },
      ],
    },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"./src"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    { choices: [], usage: { prompt_tokens: 3, completion_tokens: 4 } },
    "[DONE]",
  ];

  test("one tool_calls entry reaches a chat client, named before its arguments finish", async () => {
    const harness = await harnessOn("openai", () => stream(fragments));

    const response = await postChat(harness.gateway, {
      model: "fast",
      stream: true,
      messages: [{ role: "user", content: "what is in ./src?" }],
      tools: [READ_FILE],
    });

    expect(response.status).toBe(200);

    const text = await response.text();
    const chunks = chatChunks(text).map((chunk) => v.parse(StreamChunkSchema, chunk));
    const deltas = chunks.flatMap((chunk) =>
      chunk.choices.flatMap((choice) => choice.delta.tool_calls ?? []),
    );

    expect(namedIds(deltas)).toEqual(["call_1"]);
    expect(namedNames(deltas)).toEqual(["read_file"]);
    expect(deltas.map((delta) => delta.function?.arguments ?? "").join("")).toBe(ARGUMENTS);

    const finishes = chunks.flatMap((chunk) => chunk.choices.map((choice) => choice.finish_reason));

    expect(finishes).toContain("tool_calls");
    expect(text).toContain("data: [DONE]");
  });

  test("one tool_use block reaches an Anthropic client, opened before its arguments finish", async () => {
    const harness = await harnessOn("openai", () => stream(fragments));

    const response = await postMessages(harness.gateway, {
      model: "fast",
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "what is in ./src?" }],
      tools: [{ name: "read_file", input_schema: { type: "object" } }],
    });

    expect(response.status).toBe(200);

    const frames = anthropicFrames(await response.text());

    expect(frames.map((frame) => frame.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);

    const block = v.parse(BlockStartSchema, frames[1]?.data);

    expect(block.content_block).toMatchObject({
      type: "tool_use",
      id: "call_1",
      name: "read_file",
      input: {},
    });

    const opened = frames
      .filter((frame) => frame.event === "content_block_start")
      .map((frame) => v.parse(BlockStartSchema, frame.data));

    expect(opened).toHaveLength(1);

    const argumentsText = frames
      .filter((frame) => frame.event === "content_block_delta")
      .map((frame) => v.parse(BlockDeltaSchema, frame.data))
      .map((delta) => delta.delta.partial_json ?? "")
      .join("");

    expect(argumentsText).toBe(ARGUMENTS);
    expect(v.parse(MessageDeltaSchema, frames[5]?.data).delta.stop_reason).toBe("tool_use");
  });

  test("a server that splits the id and the name still yields one named call", async () => {
    const harness = await harnessOn("openai", () =>
      stream([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1" }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { name: "read_file", arguments: '"./src"}' } }],
              },
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        "[DONE]",
      ]),
    );

    const response = await postChat(harness.gateway, {
      model: "fast",
      stream: true,
      messages: [{ role: "user", content: "what is in ./src?" }],
      tools: [READ_FILE],
    });

    const chunks = chatChunks(await response.text()).map((chunk) =>
      v.parse(StreamChunkSchema, chunk),
    );
    const deltas = chunks.flatMap((chunk) =>
      chunk.choices.flatMap((choice) => choice.delta.tool_calls ?? []),
    );

    expect(namedIds(deltas)).toEqual(["call_1"]);
    expect(namedNames(deltas)).toEqual(["read_file"]);
    expect(deltas.map((delta) => delta.function?.arguments ?? "").join("")).toBe(ARGUMENTS);
  });

  test("a stream with no output still answers with the block pair", async () => {
    const harness = await harnessOn("openai", () =>
      stream([
        { choices: [{ delta: {}, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 0, completion_tokens: 0 } },
        "[DONE]",
      ]),
    );

    const response = await postMessages(harness.gateway, {
      model: "fast",
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });

    const frames = anthropicFrames(await response.text());

    expect(frames.map((frame) => frame.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);

    const block = v.parse(BlockStartSchema, frames[1]?.data);

    expect(block.content_block).toEqual({ type: "text", text: "" });
    expect(v.parse(StopSchema, frames[2]?.data).index).toBe(0);
    expect(v.parse(MessageDeltaSchema, frames[3]?.data).delta.stop_reason).toBe("end_turn");
  });
});

describe("canonical tool types", () => {
  // The compiler is the judge here: both literals below have to fail to type-check.
  // @ts-expect-error a tool call cannot be built without the name it asks for
  const nameless: ToolCall = { id: "call_1", arguments: "{}" };
  // @ts-expect-error a tool result cannot be built without the id of the call it answers
  const uncalled: ToolResult = { content: "ok", isError: false };

  test("the two shapes the compiler refuses are the ones the wires would drop", () => {
    expect([nameless, uncalled]).toHaveLength(2);
  });
});

const auth = {
  handler: () => Promise.resolve(new Response(null)),
  getSession: () => Promise.resolve(null),
  verifyApiKey: () => Promise.resolve({ userId: "user-1", keyId: "key-1" }),
} satisfies Auth;

async function harnessOn(
  kind: "openai" | "anthropic" | "google",
  handle: (call: Call) => Response | Promise<Response>,
  compat: Compat | null = null,
): Promise<Harness> {
  const upstream = await startUpstream(handle);
  const database = openDatabase(":memory:");

  applyMigrations(database.sqlite, migrations());
  database.db.insert(user).values({ id: "user-1", name: "User", email: "user@test" }).run();

  const duck = new DuckDb(":memory:", DUCK_LIB);

  applyDuckMigrations(duck, duckMigrations());

  cleanup.push(() => database.sqlite.close(), () => duck.close());

  const providers: ProviderDeps = {
    db: database.db,
    sealer: await createSealer("test-secret"),
    endpoints: DEFAULT_PROVIDER_ENDPOINTS,
  };

  const provider = await createProvider(providers, "user-1", {
    name: "Test",
    kind,
    baseUrl: upstream.origin,
    apiKey: "",
  });

  const added = await addProviderModel(providers, "user-1", provider.id, {
    upstreamModel: "m",
    slug: "fast",
  });

  const modelId = added?.models.find((model) => model.slug === "fast")?.id ?? "";

  expect(modelId).not.toBe("");

  const credential = await addProviderCredential(providers, "user-1", provider.id, {
    label: "key",
    apiKey: "upstream-key",
  });

  expect(credential.kind).toBe("ok");

  if (compat !== null)
    await updateProviderModel(providers, "user-1", provider.id, modelId, {
      slug: "fast",
      alias: null,
      compat,
      inputPricePerMtok: null,
      cacheInputPricePerMtok: null,
      outputPricePerMtok: null,
    });

  return { gateway: createGateway({ duck, providers, auth }), upstream };
}

async function startUpstream(
  handle: (call: Call) => Response | Promise<Response>,
): Promise<Upstream> {
  const calls: Call[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const call: Call = {
        path: new URL(request.url).pathname,
        headers: request.headers,
        body: await request.json(),
      };

      calls.push(call);

      return handle(call);
    },
  });

  cleanup.push(() => void server.stop(true));

  return { origin: "http://127.0.0.1:" + String(server.port), calls };
}

function postChat(gateway: Harness["gateway"], body: unknown): Promise<Response> {
  return gateway.handle(
    new Request("http://gateway.test/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer bandar_test" },
      body: JSON.stringify(body),
    }),
  );
}

function postMessages(gateway: Harness["gateway"], body: unknown): Promise<Response> {
  return gateway.handle(
    new Request("http://gateway.test/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "bandar_test" },
      body: JSON.stringify(body),
    }),
  );
}

function json(body: unknown): Response {
  return Response.json(body);
}

function stream(events: readonly unknown[]): Response {
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream({
      start(controller) {
        for (const event of events) {
          const data = event === "[DONE]" ? "[DONE]" : JSON.stringify(event);

          controller.enqueue(encoder.encode("data: " + data + "\n\n"));
        }

        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

type ToolDelta = v.InferOutput<typeof StreamChunkSchema>["choices"][number]["delta"]["tool_calls"];

function namedIds(deltas: readonly NonNullable<ToolDelta>[number][]): readonly string[] {
  return deltas.flatMap((delta) => (delta.id === undefined ? [] : [delta.id]));
}

function namedNames(deltas: readonly NonNullable<ToolDelta>[number][]): readonly string[] {
  return deltas.flatMap((delta) =>
    delta.function?.name === undefined ? [] : [delta.function.name],
  );
}

function chatChunks(text: string): readonly unknown[] {
  return text
    .split("\n\n")
    .filter((block) => block.trim() !== "")
    .map((block) => block.replace(/^data: /u, ""))
    .filter((data) => data !== "[DONE]")
    .map((data) => JSON.parse(data) as unknown);
}

type AnthropicFrame = { readonly event: string; readonly data: unknown };

function anthropicFrames(text: string): readonly AnthropicFrame[] {
  return text
    .split("\n\n")
    .filter((block) => block.trim() !== "")
    .map((block) => {
      const lines = block.split("\n");

      return {
        event: lines.find((line) => line.startsWith("event: "))?.slice("event: ".length) ?? "",
        data: JSON.parse(
          lines.find((line) => line.startsWith("data: "))?.slice("data: ".length) ?? "{}",
        ) as unknown,
      };
    });
}

function migrations(): readonly Migration[] {
  return readdirSync(SQLITE_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({ tag: name.slice(0, -4), sql: readFileSync(join(SQLITE_DIR, name), "utf8") }));
}

function duckMigrations() {
  return readdirSync(DUCK_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({ tag: name.slice(0, -4), sql: readFileSync(join(DUCK_DIR, name), "utf8") }));
}
