import * as v from "valibot";
import {
  DEFAULT_TOOL_PARAMETERS,
  ToolParametersSchema,
  pushText,
  type InboundMessage,
  type InboundPart,
  type MessagePart,
  type MessageRole,
  type ToolChoice,
  type ToolDefinition,
} from "./conversation";
import { contentText, type Normalized } from "./messages";
import { parseImageUrl } from "./media";
import { ReasoningEffortSchema, type Reasoning, type ReasoningEffort } from "./reasoning";
import { MAX_MODEL_REF_LENGTH } from "./slugs";

const ChatFunctionSchema = v.object({
  name: v.pipe(v.string(), v.minLength(1)),
  description: v.optional(v.string()),
  parameters: v.optional(ToolParametersSchema),
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

/** An image_url part: the url string, or the object an SDK wraps it in. */
const ImageUrlSchema = v.union([
  v.string(),
  v.looseObject({ url: v.optional(v.string()), detail: v.optional(v.string()) }),
]);

const ChatTextPartSchema = v.object({ type: v.literal("text"), text: v.optional(v.string()) });

const ChatImagePartSchema = v.object({
  type: v.literal("image_url"),
  image_url: ImageUrlSchema,
});

const ChatContentPartSchema = v.union([ChatTextPartSchema, ChatImagePartSchema]);

const ChatContentSchema = v.union([v.string(), v.array(ChatContentPartSchema)]);

type ChatContent = v.InferOutput<typeof ChatContentSchema>;

type ChatContentPart = v.InferOutput<typeof ChatContentPartSchema>;

export const ChatMessageSchema = v.object({
  role: v.picklist(["system", "developer", "user", "assistant", "tool"]),
  /** Null, or absent, is what a client sends for an assistant turn that only called tools. */
  content: v.optional(v.nullable(ChatContentSchema), null),
  tool_call_id: v.optional(v.string()),
  tool_calls: v.optional(v.array(ChatToolCallSchema)),
});

export type ChatMessage = v.InferOutput<typeof ChatMessageSchema>;

export function normalizeChatMessages(
  messages: readonly ChatMessage[],
): Normalized<readonly InboundMessage[]> {
  const turns: InboundMessage[] = [];

  for (const [index, message] of messages.entries()) {
    const turn = turnOf(message, `messages.${String(index)}`);

    if (!turn.ok) return turn;

    turns.push(turn.value);
  }

  return { ok: true, value: turns };
}

/** Per-role grammar: which tool fields a role may carry, and the exact rejection when it may not. */
function turnOf(message: ChatMessage, at: string): Normalized<InboundMessage> {
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

  const parts = partsOf(message.content, `${at}.content`, message.role);

  if (!parts.ok) return parts;

  switch (message.role) {
    case "system":
    case "developer": {
      return turn("system", parts.value);
    }

    case "user": {
      return turn("user", parts.value);
    }

    case "assistant": {
      const calls = (message.tool_calls ?? []).map(callPart);

      return turn("assistant", [...spokenOf(parts.value, calls.length > 0), ...calls]);
    }

    case "tool": {
      if (message.tool_call_id === undefined)
        return rejected(
          `${at}.tool_call_id`,
          `${at}.tool_call_id: a tool message needs the id of the call it answers`,
        );

      const text = contentText(message.content, `${at}.content`);

      if (!text.ok) return text;

      return turn("user", [
        {
          type: "tool_result",
          result: { toolCallId: message.tool_call_id, content: text.value, isError: false },
        },
      ]);
    }
  }
}

/** The text and image parts of one content value, in the order the client wrote them. */
function partsOf(
  content: ChatContent | null | undefined,
  at: string,
  role: ChatMessage["role"],
): Normalized<readonly InboundPart[]> {
  if (v.is(v.string(), content)) return { ok: true, value: [{ type: "text", text: content }] };

  if (content === null || content === undefined) return { ok: true, value: emptyTurn() };

  return partsOfArray(content, at, role);
}

function partsOfArray(
  content: readonly ChatContentPart[],
  at: string,
  role: ChatMessage["role"],
): Normalized<readonly InboundPart[]> {
  const parts: InboundPart[] = [];

  for (const [index, part] of content.entries()) {
    const partAt = `${at}.${String(index)}`;

    if (part.type === "text") {
      pushText(parts, part.text ?? "", "\n");
      continue;
    }

    if (role !== "user")
      return rejected(partAt, `${partAt}: image_url parts belong in a user turn`);

    const url = v.is(v.string(), part.image_url) ? part.image_url : part.image_url.url;

    if (url === undefined) return rejected(partAt, `${partAt}: image_url part carries no url`);

    const origin = parseImageUrl(url);

    if (origin === null)
      return rejected(partAt, `${partAt}: image_url is not a data: or http(s) url`);

    parts.push({ type: "image_pending", origin, at: partAt });
  }

  return { ok: true, value: parts.length === 0 ? emptyTurn() : parts };
}

/** An assistant turn that only called tools drops the placeholder its empty content became. */
function spokenOf(parts: readonly InboundPart[], called: boolean): readonly InboundPart[] {
  if (!called || parts.length !== 1) return parts;

  const [only] = parts;

  if (only?.type === "text" && only.text === "") return [];

  return parts;
}

/** A turn that carried nothing still travels as one empty text part, as it did before images. */
function emptyTurn(): readonly InboundPart[] {
  return [{ type: "text", text: "" }];
}

function callPart(call: v.InferOutput<typeof ChatToolCallSchema>): MessagePart {
  return {
    type: "tool_call",
    call: { id: call.id, name: call.function.name, arguments: call.function.arguments },
  };
}

function turn(role: MessageRole, content: readonly InboundPart[]): Normalized<InboundMessage> {
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
  reasoning_effort: v.optional(ReasoningEffortSchema),
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
    toolChoice: input.tool_choice === undefined ? null : chatChoiceOf(input.tool_choice),
    reasoning: input.reasoning_effort === undefined ? undefined : effort(input.reasoning_effort),
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

function effort(level: ReasoningEffort): Reasoning {
  return { kind: "effort", effort: level };
}

export type ToolChoicePick = "auto" | "none" | "required";

export function choiceOf(choice: ToolChoicePick | { readonly name: string }): ToolChoice {
  if (choice === "auto") return { mode: "auto" };

  if (choice === "none") return { mode: "none" };

  if (choice === "required") return { mode: "required" };

  return { mode: "tool", name: choice.name };
}

function chatChoiceOf(choice: v.InferOutput<typeof ChatToolChoiceSchema>): ToolChoice {
  if (choice === "auto" || choice === "none" || choice === "required") return choiceOf(choice);

  return choiceOf({ name: choice.function.name });
}
