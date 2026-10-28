import * as v from "valibot";
import { MAX_MODEL_REF_LENGTH } from "./slugs";

const BlockSchema = v.object({ type: v.string(), text: v.optional(v.string()) });

const ContentSchema = v.union([v.string(), v.array(BlockSchema)]);

export const MessagesRequestSchema = v.object({
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
});

export type MessagesRequest = v.InferOutput<typeof MessagesRequestSchema>;

type MessagesContent = v.InferOutput<typeof ContentSchema>;

export type MessagesTurn = {
  readonly role: "user" | "assistant";
  readonly text: string;
};

export type NormalizedMessages = {
  readonly system: string;
  readonly messages: readonly MessagesTurn[];
};

export type MessagesRejection = {
  readonly status: number;
  readonly message: string;
};

export type MessagesNormalization =
  | { readonly ok: true; readonly value: NormalizedMessages }
  | { readonly ok: false; readonly rejection: MessagesRejection };

/** The canonical path is text only, so every non-text block is a rejection rather than a drop. */
export function normalizeMessages(request: MessagesRequest): MessagesNormalization {
  const system = textOf(request.system, "system");

  if (!system.ok) return system;

  const messages: MessagesTurn[] = [];

  for (const [index, message] of request.messages.entries()) {
    const text = textOf(message.content, `messages[${String(index)}].content`);

    if (!text.ok) return text;

    messages.push({ role: message.role, text: text.value });
  }

  return { ok: true, value: { system: system.value, messages } };
}

export function promptText({ system, messages }: NormalizedMessages): string {
  return [system, ...messages.map((message) => message.text)]
    .filter((part) => part !== "")
    .join("\n");
}

function textOf(
  content: MessagesContent | undefined,
  at: string,
):
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly rejection: MessagesRejection } {
  if (content === undefined) return { ok: true, value: "" };

  const single = v.safeParse(v.string(), content);

  if (single.success) return { ok: true, value: single.output };

  const blocks = v.safeParse(v.array(BlockSchema), content);

  if (!blocks.success)
    return { ok: false, rejection: { status: 422, message: `${at}: content is not text` } };

  const parts: string[] = [];

  for (const [index, block] of blocks.output.entries()) {
    const blockAt = `${at}[${String(index)}]`;

    if (block.type !== "text") return { ok: false, rejection: unsupported(blockAt, block.type) };

    if (block.text === undefined)
      return {
        ok: false,
        rejection: { status: 422, message: `${blockAt}: text block has no text` },
      };

    parts.push(block.text);
  }

  return { ok: true, value: parts.join("\n") };
}

function unsupported(at: string, type: string): MessagesRejection {
  return { status: 422, message: `${at}: ${type} blocks are not supported by this text gateway` };
}
