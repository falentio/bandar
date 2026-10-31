import * as v from "valibot";
import {
  DEFAULT_TOOL_PARAMETERS,
  ToolParametersSchema,
  coalesceText,
  type ConversationMessage,
  type MessagePart,
  type ToolChoice,
  type ToolDefinition,
} from "./conversation";
import { MAX_MODEL_REF_LENGTH } from "./slugs";
import type { Reasoning } from "./reasoning";

const TextBlockSchema = v.object({ type: v.string(), text: v.optional(v.string()) });

const BlockSchema = v.object({
  type: v.string(),
  text: v.optional(v.string()),
  id: v.optional(v.string()),
  name: v.optional(v.string()),
  input: v.optional(ToolParametersSchema),
  tool_use_id: v.optional(v.string()),
  content: v.optional(v.union([v.string(), v.array(TextBlockSchema)])),
  is_error: v.optional(v.boolean()),
});

export const ContentSchema = v.union([v.string(), v.array(BlockSchema)]);

type Content = v.InferOutput<typeof ContentSchema>;

type Block = v.InferOutput<typeof BlockSchema>;

type TextBlock = v.InferOutput<typeof TextBlockSchema>;

/** One content value in text form: the string shorthand, or the blocks the wire listed. */
type TextContent = string | readonly TextBlock[];

/** The blocks a content value lists; the string shorthand is one text block. */
function blocksOf(content: TextContent): readonly TextBlock[] {
  return v.is(v.string(), content) ? [{ type: "text", text: content }] : content;
}

const AnthropicToolSchema = v.object({
  name: v.pipe(v.string(), v.minLength(1)),
  description: v.optional(v.string()),
  input_schema: v.optional(ToolParametersSchema),
});

const AnthropicToolChoiceSchema = v.variant("type", [
  v.object({ type: v.literal("auto") }),
  v.object({ type: v.literal("any") }),
  v.object({ type: v.literal("none") }),
  v.object({ type: v.literal("tool"), name: v.pipe(v.string(), v.minLength(1)) }),
]);

/** The ladder this wire accepts, which lacks the two rungs OpenAI has below "low". */
export const ANTHROPIC_EFFORT_VALUES = ["low", "medium", "high", "xhigh", "max"] as const;

type AnthropicEffort = (typeof ANTHROPIC_EFFORT_VALUES)[number];

const AnthropicEffortSchema: v.GenericSchema<AnthropicEffort> = v.picklist(ANTHROPIC_EFFORT_VALUES);

const ThinkingSchema = v.variant("type", [
  v.object({ type: v.literal("enabled"), budget_tokens: v.number() }),
  v.object({ type: v.literal("disabled") }),
]);

const OutputConfigSchema = v.object({ effort: v.optional(AnthropicEffortSchema) });

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
  thinking: v.optional(ThinkingSchema),
  output_config: v.optional(OutputConfigSchema),
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
    reasoning: reasoningOf(input.thinking, input.output_config),
  })),
);

export type MessagesRequest = v.InferOutput<typeof MessagesRequestSchema>;

/**
 * One request carries one kind of control: a budget and an effort together would ask two things at
 * once, so the budget wins. A `disabled` flag never travels, because models whose thinking cannot
 * be turned off reject it, where carrying no control costs nothing.
 */
function reasoningOf(
  thinking: v.InferOutput<typeof ThinkingSchema> | undefined,
  outputConfig: v.InferOutput<typeof OutputConfigSchema> | undefined,
): Reasoning | undefined {
  if (thinking?.type === "enabled") return { kind: "budget", budgetTokens: thinking.budget_tokens };

  if (outputConfig?.effort !== undefined) return { kind: "effort", effort: outputConfig.effort };

  return undefined;
}

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
export function contentText(content: Content | null | undefined, at: string): Normalized<string> {
  if (content === undefined || content === null) return { ok: true, value: "" };

  return textOfBlocks(blocksOf(content), at);
}

function textOfBlocks(blocks: readonly TextBlock[], at: string): Normalized<string> {
  const texts: string[] = [];

  for (const [index, block] of blocks.entries()) {
    const blockAt = `${at}.${String(index)}`;

    if (block.type !== "text") return unsupported(blockAt, block.type);

    if (block.text === undefined) return rejected(blockAt, `${blockAt}: text block has no text`);

    texts.push(block.text);
  }

  return { ok: true, value: texts.join("\n") };
}

export function promptText({ system, messages }: NormalizedMessages): string {
  return [system, ...messages.map(promptTextOf)].filter((part) => part !== "").join("\n");
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
  const parts: MessagePart[] = [];

  for (const [index, block] of blocksOf(content).entries()) {
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
function resultText(content: TextContent | undefined, at: string): Normalized<string> {
  if (content === undefined) return { ok: true, value: "" };

  return textOfBlocks(blocksOf(content), `${at}.content`);
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
