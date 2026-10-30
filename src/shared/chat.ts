import * as v from "valibot";
import {
  DEFAULT_TOOL_PARAMETERS,
  coalesceText,
  type ConversationMessage,
  type MessagePart,
  type MessageRole,
  type ToolChoice,
  type ToolDefinition,
} from "./conversation";
import { ContentSchema, contentText, type Normalized } from "./messages";
import { MAX_MODEL_REF_LENGTH } from "./slugs";

const ChatFunctionSchema = v.object({
  name: v.pipe(v.string(), v.minLength(1)),
  description: v.optional(v.string()),
  parameters: v.optional(v.record(v.string(), v.unknown())),
});

const ChatToolSchema = v.object({
  type: v.literal("function"),
  function: ChatFunctionSchema,
});

const ChatToolChoiceSchema = v.union([
  v.picklist(["auto", "none", "required"]),
  v.object({
    type: v.literal("function"),
    function: v.object({ name: v.pipe(v.string(), v.minLength(1)) }),
  }),
]);

const ChatToolCallSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  type: v.optional(v.literal("function")),
  function: v.object({
    name: v.pipe(v.string(), v.minLength(1)),
    arguments: v.optional(v.string(), ""),
  }),
});

export const ChatMessageSchema = v.object({
  role: v.picklist(["system", "developer", "user", "assistant", "tool"]),
  /** Null, or absent, is what a client sends for an assistant turn that only called tools. */
  content: v.optional(v.nullable(ContentSchema), null),
  tool_call_id: v.optional(v.string()),
  tool_calls: v.optional(v.array(ChatToolCallSchema)),
});

export type ChatMessage = v.InferOutput<typeof ChatMessageSchema>;

export function normalizeChatMessages(
  messages: readonly ChatMessage[],
): Normalized<readonly ConversationMessage[]> {
  const turns: ConversationMessage[] = [];

  for (const [index, message] of messages.entries()) {
    const turn = turnOf(message, `messages.${String(index)}`);

    if (!turn.ok) return turn;

    turns.push(turn.value);
  }

  return { ok: true, value: turns };
}

/** Per-role grammar: which tool fields a role may carry, and the exact rejection when it may not. */
function turnOf(message: ChatMessage, at: string): Normalized<ConversationMessage> {
  if (message.tool_call_id !== undefined && message.role !== "tool")
    return rejected(
      `${at}.tool_call_id`,
      `${at}.tool_call_id: only a tool message carries tool_call_id`,
    );

  if (message.tool_calls !== undefined && message.role !== "assistant")
    return rejected(
      `${at}.tool_calls`,
      `${at}.tool_calls: only an assistant message carries tool_calls`,
    );

  const text = contentText(message.content, `${at}.content`);

  if (!text.ok) return text;

  switch (message.role) {
    case "system":
    case "developer": {
      return turn("system", [{ type: "text", text: text.value }]);
    }

    case "user": {
      return turn("user", [{ type: "text", text: text.value }]);
    }

    case "assistant": {
      const calls = (message.tool_calls ?? []).map(callPart);

      const parts: MessagePart[] =
        calls.length > 0 && text.value === "" ? calls : [{ type: "text", text: text.value }];

      return turn("assistant", coalesceText(parts, "\n"));
    }

    case "tool": {
      if (message.tool_call_id === undefined)
        return rejected(
          `${at}.tool_call_id`,
          `${at}.tool_call_id: a tool message needs the id of the call it answers`,
        );

      return turn("user", [
        {
          type: "tool_result",
          result: { toolCallId: message.tool_call_id, content: text.value, isError: false },
        },
      ]);
    }
  }
}

function callPart(call: v.InferOutput<typeof ChatToolCallSchema>): MessagePart {
  return {
    type: "tool_call",
    call: { id: call.id, name: call.function.name, arguments: call.function.arguments },
  };
}

function turn(role: MessageRole, content: readonly MessagePart[]): Normalized<ConversationMessage> {
  return { ok: true, value: { role, content } };
}

function rejected(param: string, message: string) {
  return { ok: false as const, rejection: { status: 422, param, message } };
}

export const ChatCompletionRequestSchema = v.object({
  model: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_MODEL_REF_LENGTH)),
  messages: v.pipe(v.array(ChatMessageSchema), v.minLength(1)),
  stream: v.optional(v.boolean(), false),
  temperature: v.optional(v.number()),
  top_p: v.optional(v.number()),
  max_tokens: v.optional(v.number()),
  max_completion_tokens: v.optional(v.number()),
  stop: v.optional(v.union([v.string(), v.array(v.string())])),
  tools: v.optional(v.array(ChatToolSchema)),
  tool_choice: v.optional(ChatToolChoiceSchema),
});

export const ModelCardSchema = v.object({
  id: v.string(),
  object: v.literal("model"),
  created: v.number(),
  owned_by: v.string(),
});

export const ModelListSchema = v.object({
  object: v.literal("list"),
  data: v.array(ModelCardSchema),
});

export const GatewayRequestSchema = v.pipe(
  ChatCompletionRequestSchema,
  v.transform((input) => ({
    model: input.model,
    messages: input.messages,
    stream: input.stream ?? false,
    temperature: input.temperature,
    topP: input.top_p,
    maxTokens: input.max_tokens ?? input.max_completion_tokens,
    stop:
      input.stop === undefined ? undefined : Array.isArray(input.stop) ? input.stop : [input.stop],
    tools: (input.tools ?? []).map(toolOf),
    toolChoice: input.tool_choice === undefined ? null : choiceOf(input.tool_choice),
  })),
);

export type GatewayRequest = v.InferOutput<typeof GatewayRequestSchema>;

export type ChatCompletionRequest = v.InferOutput<typeof ChatCompletionRequestSchema>;

export type ModelList = v.InferOutput<typeof ModelListSchema>;

function toolOf(tool: v.InferOutput<typeof ChatToolSchema>): ToolDefinition {
  return {
    name: tool.function.name,
    description: tool.function.description ?? null,
    parameters: tool.function.parameters ?? DEFAULT_TOOL_PARAMETERS,
  };
}

function choiceOf(choice: v.InferOutput<typeof ChatToolChoiceSchema>): ToolChoice {
  if (choice === "auto") return { mode: "auto" };

  if (choice === "none") return { mode: "none" };

  if (choice === "required") return { mode: "required" };

  return { mode: "tool", name: choice.function.name };
}
