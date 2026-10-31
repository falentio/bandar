import * as v from "valibot";
import {
  DEFAULT_TOOL_PARAMETERS,
  ToolParametersSchema,
  coalesceText,
  type ConversationMessage,
  type MessagePart,
  type ToolDefinition,
} from "./conversation";
import { choiceOf } from "./chat";
import type { Normalized } from "./messages";
import { ReasoningEffortSchema, type Reasoning } from "./reasoning";
import { MAX_MODEL_REF_LENGTH } from "./slugs";

const TextPartSchema = v.object({
  type: v.picklist(["input_text", "output_text", "text"]),
  text: v.string(),
});

const TextContentSchema = v.variant("kind", [
  v.object({ kind: v.literal("text"), value: v.string() }),
  v.object({ kind: v.literal("parts"), value: v.array(TextPartSchema) }),
]);

/** A client sends the typed item, or the bare item this gateway's own egress writes. */
const MessageItemSchema = v.object({
  type: v.optional(v.literal("message")),
  role: v.picklist(["user", "assistant", "system", "developer"]),
  content: v.unknown(),
});

const FunctionCallItemSchema = v.object({
  type: v.literal("function_call"),
  call_id: v.pipe(v.string(), v.minLength(1)),
  name: v.pipe(v.string(), v.minLength(1)),
  arguments: v.optional(v.string(), ""),
});

const FunctionCallOutputItemSchema = v.object({
  type: v.literal("function_call_output"),
  call_id: v.pipe(v.string(), v.minLength(1)),
  output: v.string(),
});

const ItemSchema = v.union([
  v.looseObject({ type: v.optional(v.literal("message")) }),
  v.looseObject({ type: v.literal("function_call") }),
  v.looseObject({ type: v.literal("function_call_output") }),
]);

type Item = v.InferOutput<typeof ItemSchema>;

const ResponsesToolSchema = v.object({
  type: v.literal("function"),
  name: v.pipe(v.string(), v.minLength(1)),
  description: v.optional(v.string()),
  parameters: v.optional(ToolParametersSchema),
});

const ResponsesToolChoiceSchema = v.union([
  v.picklist(["auto", "none", "required"]),
  v.object({
    type: v.literal("function"),
    name: v.pipe(v.string(), v.minLength(1)),
  }),
]);

const ReasoningSchema = v.object({
  effort: v.optional(ReasoningEffortSchema),
  summary: v.optional(v.string()),
});

const ResponsesBodySchema = v.object({
  model: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_MODEL_REF_LENGTH)),
  input: v.pipe(
    v.union([v.array(v.unknown()), v.string()]),
    v.transform((input) =>
      v.is(v.string(), input)
        ? { kind: "text" as const, value: input }
        : { kind: "items" as const, value: input },
    ),
  ),
  instructions: v.optional(v.string()),
  stream: v.optional(v.boolean(), false),
  max_output_tokens: v.optional(v.number()),
  temperature: v.optional(v.number()),
  top_p: v.optional(v.number()),
  stop: v.optional(v.union([v.string(), v.array(v.string())])),
  tools: v.optional(v.array(ResponsesToolSchema)),
  tool_choice: v.optional(ResponsesToolChoiceSchema),
  reasoning: v.optional(ReasoningSchema),
});

export const ResponsesRequestSchema = v.pipe(
  ResponsesBodySchema,
  v.transform((input) => ({
    model: input.model,
    input: input.input,
    instructions: input.instructions,
    stream: input.stream,
    maxOutputTokens: input.max_output_tokens,
    temperature: input.temperature,
    topP: input.top_p,
    stop:
      input.stop === undefined ? undefined : Array.isArray(input.stop) ? input.stop : [input.stop],
    tools: (input.tools ?? []).map(toolOf),
    toolChoice: input.tool_choice === undefined ? null : choiceOf(input.tool_choice),
    reasoning: reasoningOf(input.reasoning),
  })),
);

export type ResponsesRequest = v.InferOutput<typeof ResponsesRequestSchema>;

export function normalizeResponses(
  request: ResponsesRequest,
): Normalized<readonly ConversationMessage[]> {
  if (request.input.kind === "text")
    return {
      ok: true,
      value: [{ role: "user", content: [{ type: "text", text: request.input.value }] }],
    };

  const items = itemsOf(request.input.value);

  if (!items.ok) return items;

  const messages: ConversationMessage[] = [];

  for (const [index, item] of items.value.entries()) {
    const message = turnOf(item, `input.${String(index)}`);

    if (!message.ok) return message;

    messages.push(message.value);
  }

  return { ok: true, value: messages };
}

function itemsOf(input: readonly unknown[]): Normalized<readonly Item[]> {
  const items: Item[] = [];

  for (const [index, item] of input.entries()) {
    const at = `input.${String(index)}`;
    const read = v.safeParse(ItemSchema, item);

    if (read.success) {
      items.push(read.output);
      continue;
    }

    const tag = v.safeParse(v.looseObject({ type: v.optional(v.string()) }), item);

    if (!tag.success) return rejected(at, at + ": an input item must be an object");

    if (tag.output.type === undefined) return rejected(at, at + ": an input item needs a type");

    return rejected(
      at + ".type",
      at + ".type: " + tag.output.type + " items are not part of this gateway",
    );
  }

  return { ok: true, value: items };
}

function turnOf(item: Item, at: string): Normalized<ConversationMessage> {
  switch (item.type ?? "message") {
    case "function_call": {
      const call = v.safeParse(FunctionCallItemSchema, item);

      if (!call.success) return rejected(at, `${at}: ${readIssueOf("function_call", call.issues)}`);

      return {
        ok: true,
        value: {
          role: "assistant",
          content: [
            {
              type: "tool_call",
              call: {
                id: call.output.call_id,
                name: call.output.name,
                arguments: call.output.arguments,
              },
            },
          ],
        },
      };
    }

    case "function_call_output": {
      const result = v.safeParse(FunctionCallOutputItemSchema, item);

      if (!result.success)
        return rejected(at, `${at}: ${readIssueOf("function_call_output", result.issues)}`);

      return {
        ok: true,
        value: {
          role: "user",
          content: [
            {
              type: "tool_result",
              result: {
                toolCallId: result.output.call_id,
                content: result.output.output,
                isError: false,
              },
            },
          ],
        },
      };
    }

    default:
      return messageTurn(item, at);
  }
}

function textContentOf(item: Item): v.InferOutput<typeof TextContentSchema> | null {
  const read = v.safeParse(v.looseObject({ content: v.unknown() }), item);

  if (!read.success) return null;

  if (v.is(v.string(), read.output.content)) return { kind: "text", value: read.output.content };

  const parts = v.safeParse(v.array(TextPartSchema), read.output.content);

  return parts.success ? { kind: "parts", value: parts.output } : null;
}

/** A missing call id is the one call-item defect a client can fix, so it gets named rather than quoted. */
function readIssueOf(type: string, issues: readonly v.BaseIssue<unknown>[]): string {
  const first = issues[0];

  if (first !== undefined && first.path?.some((entry) => entry.key === "call_id"))
    return type + " has no call_id";

  const reason = first === undefined ? "cannot be read" : String(first.message);

  return type + ": " + reason;
}

function messageTurn(item: Item, at: string): Normalized<ConversationMessage> {
  const read = v.safeParse(MessageItemSchema, item);

  if (!read.success) return rejected(at, `${at}: ${readIssueOf("message", read.issues)}`);

  const content = textContentOf(item);

  if (content === null) return rejected(`${at}.content`, `${at}.content: content is not text`);

  const parts = partsOf(content, `${at}.content`);

  if (!parts.ok) return parts;

  if (read.output.role === "system" || read.output.role === "developer")
    return { ok: true, value: { role: "system", content: parts.value } };

  return { ok: true, value: { role: read.output.role, content: coalesceText(parts.value, "\n") } };
}

function partsOf(
  content: v.InferOutput<typeof TextContentSchema>,
  at: string,
): Normalized<readonly MessagePart[]> {
  if (content.kind === "text") return { ok: true, value: [{ type: "text", text: content.value }] };

  if (content.value.length === 0) return rejected(at, `${at}: message item has no text`);

  return { ok: true, value: content.value.map((part) => ({ type: "text", text: part.text })) };
}

function rejected(param: string, message: string) {
  return { ok: false as const, rejection: { status: 422, param, message } };
}

/** `summary` asks for text no egress wire can carry, so it is dropped rather than forwarded. */
function reasoningOf(
  reasoning: v.InferOutput<typeof ReasoningSchema> | undefined,
): Reasoning | undefined {
  if (reasoning?.effort === undefined) return undefined;

  return { kind: "effort", effort: reasoning.effort };
}

function toolOf(tool: v.InferOutput<typeof ResponsesToolSchema>): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description ?? null,
    parameters: tool.parameters ?? DEFAULT_TOOL_PARAMETERS,
  };
}
