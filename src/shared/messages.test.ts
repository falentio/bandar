import { describe, expect, test } from "vite-plus/test";
import * as v from "valibot";
import { MessagesRequestSchema, normalizeMessages } from "./messages";

describe("normalizeMessages", () => {
  test("names a rejected block by its dotted path", () => {
    const message = normalizeMessages(
      v.parse(MessagesRequestSchema, {
        model: "tags/deepseek",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }, { type: "image" }] }],
      }),
    );

    expect(message).toEqual({
      ok: false,
      rejection: {
        status: 422,
        param: "messages.0.content.1",
        message: "messages.0.content.1: image blocks are not supported by this text gateway",
      },
    });

    const system = normalizeMessages(
      v.parse(MessagesRequestSchema, {
        model: "tags/deepseek",
        system: [{ type: "tool_use" }],
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    expect(system).toEqual({
      ok: false,
      rejection: {
        status: 422,
        param: "system.0",
        message: "system.0: tool_use blocks are not supported by this text gateway",
      },
    });
  });

  test("accepts a tool_use turn and the tool_result turn that answers it", () => {
    const message = normalizeMessages(
      v.parse(MessagesRequestSchema, {
        model: "tags/deepseek",
        messages: [
          { role: "user", content: "what is in ./src?" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "Reading it." },
              { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "./src" } },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "toolu_1", content: "chat.ts", is_error: false },
            ],
          },
        ],
        tools: [{ name: "read_file", input_schema: { type: "object" } }],
        tool_choice: { type: "auto" },
      }),
    );

    expect(message).toEqual({
      ok: true,
      value: {
        system: "",
        messages: [
          { role: "user", content: [{ type: "text", text: "what is in ./src?" }] },
          {
            role: "assistant",
            content: [
              { type: "text", text: "Reading it." },
              {
                type: "tool_call",
                call: { id: "toolu_1", name: "read_file", arguments: '{"path":"./src"}' },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                result: { toolCallId: "toolu_1", content: "chat.ts", isError: false },
              },
            ],
          },
        ],
      },
    });
  });

  test("rejects a non-text block inside a tool result with the pinned wording", () => {
    const message = normalizeMessages(
      v.parse(MessagesRequestSchema, {
        model: "tags/deepseek",
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_1", name: "read_file", input: {} }],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_1",
                content: [{ type: "image", text: "a picture" }],
              },
            ],
          },
        ],
      }),
    );

    expect(message).toEqual({
      ok: false,
      rejection: {
        status: 422,
        param: "messages.2.content.0.content.0",
        message:
          "messages.2.content.0.content.0: image blocks are not supported by this text gateway",
      },
    });
  });
});
