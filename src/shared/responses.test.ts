import { describe, expect, test } from "vite-plus/test";
import * as v from "valibot";
import type { JsonValue } from "./json";
import { ResponsesRequestSchema, normalizeResponses } from "./responses";

function firstIssuePath(parsed: v.SafeParseResult<v.GenericSchema>): readonly unknown[] {
  return (parsed.issues?.[0]?.path ?? []).map((item) => item.key);
}

function parse(body: JsonValue) {
  const parsed = v.safeParse(ResponsesRequestSchema, body);

  if (!parsed.success)
    throw new Error("the schema refused the body: " + String(parsed.issues?.[0]?.message));

  return parsed.output;
}

describe("normalizeResponses", () => {
  test("a bare string is one user turn", () => {
    const request = parse({ model: "fast", input: "what is in ./src?" });

    expect(normalizeResponses(request)).toEqual({
      ok: true,
      value: [{ role: "user", content: [{ type: "text", text: "what is in ./src?" }] }],
    });
    expect(request.instructions).toBeUndefined();
  });

  test("a typed message item joins its text parts and instructions lead the system turn", () => {
    const request = parse({
      model: "fast",
      instructions: "be brief",
      input: [
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "no essays" }],
        },
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "what is" },
            { type: "input_text", text: "2+2" },
          ],
        },
      ],
    });

    expect(normalizeResponses(request)).toEqual({
      ok: true,
      value: [
        { role: "system", content: [{ type: "text", text: "no essays" }] },
        { role: "user", content: [{ type: "text", text: "what is\n2+2" }] },
      ],
    });
    expect(request.instructions).toBe("be brief");
  });

  test("a call and its output become an assistant turn and a user turn", () => {
    const request = parse({
      model: "fast",
      input: [
        { role: "user", content: "list ./src" },
        {
          type: "function_call",
          call_id: "call_1",
          name: "read_file",
          arguments: '{"path":"./src"}',
        },
        { type: "function_call_output", call_id: "call_1", output: "chat.ts" },
      ],
    });

    expect(normalizeResponses(request)).toEqual({
      ok: true,
      value: [
        { role: "user", content: [{ type: "text", text: "list ./src" }] },
        {
          role: "assistant",
          content: [
            {
              type: "tool_call",
              call: { id: "call_1", name: "read_file", arguments: '{"path":"./src"}' },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              result: { toolCallId: "call_1", content: "chat.ts", isError: false },
            },
          ],
        },
      ],
    });
  });

  test("a message item with no text is refused at its own path", () => {
    const request = parse({ model: "fast", input: [{ role: "user", content: [] }] });

    expect(normalizeResponses(request)).toEqual({
      ok: false,
      rejection: {
        status: 422,
        param: "input.0.content",
        message: "input.0.content: message item has no text",
      },
    });
  });
});

describe("the Responses request schema", () => {
  test("reads the controls a Codex client sends", () => {
    const request = parse({
      model: "fast",
      input: [{ role: "user", content: "hi" }],
      max_output_tokens: 64,
      temperature: 0.2,
      top_p: 0.9,
      stop: "END",
      tools: [{ type: "function", name: "read_file" }],
      tool_choice: { type: "function", name: "read_file" },
      reasoning: { effort: "high", summary: "auto" },
      parallel_tool_calls: false,
    });

    expect(request).toMatchObject({
      maxOutputTokens: 64,
      temperature: 0.2,
      topP: 0.9,
      stop: ["END"],
      tools: [{ name: "read_file", description: null, parameters: { type: "object" } }],
      toolChoice: { mode: "tool", name: "read_file" },
      reasoning: { kind: "effort", effort: "high" },
    });
    expect(request).not.toHaveProperty("parallel_tool_calls");
  });

  test("names a reasoning effort the ladder does not carry", () => {
    const parsed = v.safeParse(ResponsesRequestSchema, {
      model: "fast",
      input: "hi",
      reasoning: { effort: "turbo" },
    });

    expect(parsed.success).toBe(false);
    expect(firstIssuePath(parsed)).toEqual(["reasoning", "effort"]);
  });

  test("refuses an item type this gateway does not carry, naming the item", () => {
    const request = parse({
      model: "fast",
      input: [
        { role: "user", content: "hi" },
        { type: "reasoning", summary: [] },
      ],
    });

    expect(normalizeResponses(request)).toEqual({
      ok: false,
      rejection: {
        status: 422,
        param: "input.1.type",
        message: "input.1.type: reasoning items are not part of this gateway",
      },
    });
  });

  test("names a call item that carries no call id", () => {
    const request = parse({
      model: "fast",
      input: [
        { role: "user", content: "hi" },
        { type: "function_call", name: "read_file" },
      ],
    });

    const normalized = normalizeResponses(request);

    expect(normalized.ok).toBe(false);
    expect(normalized.ok ? null : normalized.rejection.param).toBe("input.1");
    expect(normalized.ok ? "" : normalized.rejection.message).toBe(
      "input.1: function_call has no call_id",
    );
  });
});
