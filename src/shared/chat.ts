import * as v from "valibot";
import { ContentSchema, textOf, type MessagesRejection } from "./messages";
import { MAX_MODEL_REF_LENGTH } from "./slugs";

export const ChatMessageSchema = v.object({
  role: v.picklist(["system", "developer", "user", "assistant"]),
  content: ContentSchema,
});

export type ChatTurn = {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
};

export type ChatNormalization =
  | { readonly ok: true; readonly value: readonly ChatTurn[] }
  | { readonly ok: false; readonly rejection: MessagesRejection };

export function normalizeChatMessages(messages: readonly ChatMessage[]): ChatNormalization {
  const turns: ChatTurn[] = [];

  for (const [index, message] of messages.entries()) {
    const text = textOf(message.content, `messages.${String(index)}.content`);

    if (!text.ok) return text;

    turns.push({
      role: message.role === "developer" ? "system" : message.role,
      content: text.value,
    });
  }

  return { ok: true, value: turns };
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
  })),
);

export type GatewayRequest = v.InferOutput<typeof GatewayRequestSchema>;

export type ChatCompletionRequest = v.InferOutput<typeof ChatCompletionRequestSchema>;

export type ChatMessage = v.InferOutput<typeof ChatMessageSchema>;

export type ModelList = v.InferOutput<typeof ModelListSchema>;
