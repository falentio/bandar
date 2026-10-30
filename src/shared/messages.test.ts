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
});
