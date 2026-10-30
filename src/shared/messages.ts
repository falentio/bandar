import * as v from "valibot";
import {
  DEFAULT_TOOL_PARAMETERS,
  coalesceText,
  type ConversationMessage,
  type MessagePart,
  type ToolChoice,
  type ToolDefinition,
} from "./conversation";
import { MAX_MODEL_REF_LENGTH } from "./slugs";

const TextBlockSchema = v.object({ type: v.string(), text: v.optional(v.string()) });

const BlockSchema = v.object({
  type: v.string(),
  text: v.optional(v.string()),
  id: v.optional(v.string()),
  name: v.optional(v.string()),
  input: v.optional(v.record(v.string(), v.unknown())),
  tool_use_id: v.optional(v.string()),
  content: v.optional(v.union([v.string(), v.array(TextBlockSchema)])),
  is_error: v.optional(v.boolean()),
});

export const ContentSchema = v.union([v.string(), v.array(BlockSchema)]);

type Content = v.InferOutput<typeof ContentSchema>;

type Block = v.InferOutput<typeof BlockSchema>;

const AnthropicToolSchema = v.object({
  name: v.pipe(v.string(), v.minLength(1)),
  description: v.optional(v.string()),
  input_schema: v.optional(v.record(v.string(), v.unknown())),
});

const AnthropicToolChoiceSchema = v.variant("type", [
  v.object({ type: v.literal("auto") }),
  v.object({ type: v.literal("any") }),
  v.object({ type: v.literal("none") }),
  v.object({ type: v.literal("tool"), name: v.pipe(v.string(), v.minLength(1)) }),
]);

const MessagesBodySchema = v.object({
  model: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_MODEL_REF_LENGTH)),
  messages: v.pipe(
    v.array(
      v.object({
        role: v.picklist(["user", "assistant"]),
        content: ContentSchema,
      }),
    ),
    v.minLength(1),
  ),
  system: v.optional(ContentSchema),
  stream: v.optional(v.boolean(), false),
  max_tokens: v.optional(v.number()),
  temperature: v.optional(v.number()),
  top_p: v.optional(v.number()),
  stop_sequences: v.optional(v.array(v.string())),
  tools: v.optional(v.array(AnthropicToolSchema)),
  tool_choice: v.optional(AnthropicToolChoiceSchema),
});

export const MessagesRequestSchema = v.pipe(
  MessagesBodySchema,
  v.transform((input) => ({
    model: input.model,
    messages: input.messages,
    system: input.system,
    stream: input.stream,
    max_tokens: input.max_tokens,
    temperature: input.temperature,
    top_p: input.top_p,
    stop_sequences: input.stop_sequences,
    tools: (input.tools ?? []).map(toolOf),
    toolChoice: input.tool_choice === undefined ? null : choiceOf(input.tool_choice),
  })),
);

export type MessagesRequest = v.InferOutput<typeof MessagesRequestSchema>;

export type NormalizedMessages = {
  readonly system: string;
  readonly messages: readonly ConversationMessage[];
};

export type MessagesRejection = {
  readonly status: number;
  readonly param: string;
  readonly message: string;
};

export type Accepted<T> = { readonly ok: true; readonly value: T };
export type Rejected = { readonly ok: false; readonly rejection: MessagesRejection };
export type Normalized<T> = Accepted<T> | Rejected;

export function normalizeMessages(request: MessagesRequest): Normalized<NormalizedMessages> {
  const system = contentText(request.system, "system");

  if (!system.ok) return system;

  const messages: ConversationMessage[] = [];

  for (const [index, message] of request.messages.entries()) {
    const parts = partsOf(message.content, `messages.${String(index)}.content`, message.role);

    if (!parts.ok) return parts;

    messages.push({ role: message.role, content: coalesceText(parts.value, "\n") });
  }

  return { ok: true, value: { system: system.value, messages } };
}

/** The text of one content value, rejecting any non-text block at its dotted path. */
export function contentText(
  content: Content | null | undefined,
  at: string,
): Normalized<string> {
  if (content === undefined || content === null) return { ok: true, value: "" };

  if (typeof content === "string") return { ok: true, value: content };

  const texts: string[] = [];

  for (const [index, block] of content.entries()) {
    const blockAt = `${at}.${String(index)}`;

    if (block.type !== "text") return unsupported(blockAt, block.type);

    if (block.text === undefined) return rejected(blockAt, `${blockAt}: text block has no text`);

    texts.push(block.text);
  }

  return { ok: true, value: texts.join("\n") };
}

export function promptText({ system, messages }: NormalizedMessages): string {
  return [system, ...messages.map(promptTextOf)]
    .filter((part) => part !== "")
    .join("\n");
}

/** Tool text counts toward the estimate, but tool definitions do not. It stays an estimate. */
function promptTextOf(message: ConversationMessage): string {
  return message.content
    .flatMap((part) => {
      switch (part.type) {
        case "text": {
          return [part.text];
        }

        case "tool_call": {
          return [`${part.call.name}(${part.call.arguments})`];
        }

        case "tool_result": {
          return [part.result.content];
        }
      }
    })
    .filter((part) => part !== "")
    .join("\n");
}

/** Blocks to parts for one turn. tool_use belongs to assistant turns, tool_result to user turns. */
function partsOf(
  content: Content,
  at: string,
  role: "user" | "assistant",
): Normalized<readonly MessagePart[]> {
  if (typeof content === "string") return { ok: true, value: [{ type: "text", text: content }] };

  const parts: MessagePart[] = [];

  for (const [index, block] of content.entries()) {
    const part = partOf(block, `${at}.${String(index)}`, role);

    if (!part.ok) return part;

    parts.push(part.value);
  }

  return { ok: true, value: parts };
}

function partOf(block: Block, at: string, role: "user" | "assistant"): Normalized<MessagePart> {
  switch (block.type) {
    case "text": {
      if (block.text === undefined) return rejected(at, `${at}: text block has no text`);

      return { ok: true, value: { type: "text", text: block.text } };
    }

    case "tool_use": {
      if (role !== "assistant") return rejected(at, `${at}: tool_use belongs in an assistant turn`);

      if (block.id === undefined) return rejected(at, `${at}: tool_use has no id`);

      if (block.name === undefined) return rejected(at, `${at}: tool_use has no name`);

      return {
        ok: true,
        value: {
          type: "tool_call",
          call: {
            id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          },
        },
      };
    }

    case "tool_result": {
      if (role !== "user") return rejected(at, `${at}: tool_result belongs in a user turn`);

      if (block.tool_use_id === undefined)
        return rejected(at, `${at}: tool_result has no tool_use_id`);

      const content = resultText(block.content, at);

      if (!content.ok) return content;

      return {
        ok: true,
        value: {
          type: "tool_result",
          result: {
            toolCallId: block.tool_use_id,
            content: content.value,
            isError: block.is_error ?? false,
          },
        },
      };
    }

    default: {
      return unsupported(at, block.type);
    }
  }
}

/** A result's own content is text only: this gateway carries no other modality to a model. */
function resultText(
  content: string | readonly v.InferOutput<typeof TextBlockSchema>[] | undefined,
  at: string,
): Normalized<string> {
  if (content === undefined) return { ok: true, value: "" };

  if (typeof content === "string") return { ok: true, value: content };

  const texts: string[] = [];

  for (const [index, block] of content.entries()) {
    const blockAt = `${at}.content.${String(index)}`;

    if (block.type !== "text") return unsupported(blockAt, block.type);

    if (block.text === undefined) return rejected(blockAt, `${blockAt}: text block has no text`);

    texts.push(block.text);
  }

  return { ok: true, value: texts.join("\n") };
}

function unsupported(at: string, type: string): Rejected {
  return rejected(at, `${at}: ${type} blocks are not supported by this text gateway`);
}

function rejected(param: string, message: string): Rejected {
  return { ok: false, rejection: { status: 422, param, message } };
}

function toolOf(tool: v.InferOutput<typeof AnthropicToolSchema>): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description ?? null,
    parameters: tool.input_schema ?? DEFAULT_TOOL_PARAMETERS,
  };
}

function choiceOf(choice: v.InferOutput<typeof AnthropicToolChoiceSchema>): ToolChoice {
  switch (choice.type) {
    case "auto": {
      return { mode: "auto" };
    }

    case "any": {
      return { mode: "required" };
    }

    case "none": {
      return { mode: "none" };
    }

    case "tool": {
      return { mode: "tool", name: choice.name };
    }
  }
}
