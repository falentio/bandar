import * as v from "valibot";
import { JsonValueSchema, type JsonValue } from "./json";

/** The vocabulary a conversation is made of, independent of any dialect. */

export type MessageRole = "system" | "user" | "assistant";

/** A tool's input schema, verbatim as the client sent it. The canonical layer never inspects it. */
export type ToolParameters = Readonly<Record<string, JsonValue>>;

/** A tool's input schema as a wire sends it: any JSON object, read no further. */
export const ToolParametersSchema: v.GenericSchema<ToolParameters> = v.record(
  v.string(),
  JsonValueSchema,
);

export type ToolDefinition = {
  readonly name: string;
  readonly description: string | null;
  readonly parameters: ToolParameters;
};

export type ToolChoice =
  | { readonly mode: "auto" }
  | { readonly mode: "none" }
  | { readonly mode: "required" }
  | { readonly mode: "tool"; readonly name: string };

export type ToolCall = {
  readonly id: string;
  readonly name: string;
  /** The upstream's raw JSON text: a complete document once the call is complete, never re-encoded. */
  readonly arguments: string;
};

/** A call whose name is known and whose arguments may still be arriving. */
export type ToolCallDraft = {
  readonly id: string;
  readonly name: string;
};

export type ToolResult = {
  readonly toolCallId: string;
  readonly content: string;
  readonly isError: boolean;
};

/**
 * One block of one turn. A text run inside one message is one part: the ingress normalizers coalesce
 * neighbouring text blocks, because every wire already treats them as one run.
 */
export type MessagePart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool_call"; readonly call: ToolCall }
  | { readonly type: "tool_result"; readonly result: ToolResult };

export type ConversationMessage = {
  readonly role: MessageRole;
  readonly content: readonly MessagePart[];
};

/** What a tool with no declared parameters means on every wire. */
export const DEFAULT_TOOL_PARAMETERS = { type: "object", properties: {} } satisfies ToolParameters;

/** Folds neighbouring text parts into one, joining their text with the separator the caller's wire uses. */
export function coalesceText(
  parts: readonly MessagePart[],
  separator: string,
): readonly MessagePart[] {
  const folded: MessagePart[] = [];

  for (const part of parts) {
    const last = folded.at(-1);

    if (part.type === "text" && last?.type === "text") {
      folded[folded.length - 1] = { type: "text", text: `${last.text}${separator}${part.text}` };
      continue;
    }

    folded.push(part);
  }

  return folded;
}

/** The flattened text of a turn, joining separate text runs with a newline. */
export function textOfParts(parts: readonly MessagePart[]): string {
  return parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

export function toolCallsOf(parts: readonly MessagePart[]): readonly ToolCall[] {
  return parts.flatMap((part) => (part.type === "tool_call" ? [part.call] : []));
}

export function toolResultsOf(parts: readonly MessagePart[]): readonly ToolResult[] {
  return parts.flatMap((part) => (part.type === "tool_result" ? [part.result] : []));
}

/** The flagless wires say a failed tool in the content, rather than in a field they do not have. */
export function toolResultText(result: ToolResult): string {
  return result.isError ? `Error: ${result.content}` : result.content;
}

/** Call id to tool name, from the assistant turns already in the conversation. */
export function toolNamesOf(messages: readonly ConversationMessage[]): ReadonlyMap<string, string> {
  const names = new Map<string, string>();

  for (const message of messages)
    for (const call of toolCallsOf(message.content)) names.set(call.id, call.name);

  return names;
}
