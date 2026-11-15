import { describe, expect, test } from "vite-plus/test";
import * as v from "valibot";
import { MessagesRequestSchema, estimateTokens, normalizeMessages, promptText } from "./messages";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==";

describe("normalizeMessages", () => {
  test("names a rejected block by its dotted path", () => {
    const message = normalizeMessages(
      v.parse(MessagesRequestSchema, {
        model: "tags/deepseek",
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "hi" },
              { type: "image", source: { type: "base64" } },
            ],
          },
        ],
      }),
    );

    expect(message).toEqual({
      ok: false,
      rejection: {
        status: 422,
        param: "messages.0.content.1",
        message: "messages.0.content.1: image blocks belong in a user turn",
      },
    });

    const document = normalizeMessages(
      v.parse(MessagesRequestSchema, {
        model: "tags/deepseek",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }, { type: "document" }] }],
      }),
    );

    expect(document).toMatchObject({
      ok: false,
      rejection: {
        param: "messages.0.content.1",
        message: "messages.0.content.1: document blocks are not part of this gateway",
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
        message: "system.0: tool_use blocks are not part of this gateway",
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

  test("carries a user turn's image as a pending part at its own path", () => {
    const message = normalizeMessages(
      v.parse(MessagesRequestSchema, {
        model: "tags/deepseek",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is this" },
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: PNG },
              },
              { type: "text", text: "and this" },
            ],
          },
        ],
      }),
    );

    expect(message).toEqual({
      ok: true,
      value: {
        system: "",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is this" },
              {
                type: "image_pending",
                origin: { kind: "inline", mediaType: "image/png", data: PNG },
                at: "messages.0.content.1",
              },
              { type: "text", text: "and this" },
            ],
          },
        ],
      },
    });
  });

  test("carries a url image, and folds text across its neighbours", () => {
    const message = normalizeMessages(
      v.parse(MessagesRequestSchema, {
        model: "tags/deepseek",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is" },
              { type: "image", source: { type: "url", url: "https://example.com/a.png" } },
              { type: "text", text: "this" },
            ],
          },
        ],
      }),
    );

    expect(message).toMatchObject({
      ok: true,
      value: {
        messages: [
          {
            content: [
              { type: "text", text: "what is" },
              {
                type: "image_pending",
                origin: { kind: "remote", url: "https://example.com/a.png" },
                at: "messages.0.content.1",
              },
              { type: "text", text: "this" },
            ],
          },
        ],
      },
    });
  });

  test("counts an image in the estimate without fetching one", () => {
    const message = normalizeMessages(
      v.parse(MessagesRequestSchema, {
        model: "tags/deepseek",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is this" },
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: PNG },
              },
            ],
          },
        ],
      }),
    );

    if (!message.ok) throw new Error("the request was refused");

    expect(promptText(message.value)).toBe("what is this");
    expect(estimateTokens(message.value)).toBe(Math.ceil("what is this".length / 4) + 85);
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
        message: "messages.2.content.0.content.0: image blocks are not part of this gateway",
      },
    });
  });
});
