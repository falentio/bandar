import type { JsonValue } from "../../shared/json";
import type { CanonicalUsage } from "../providers/types";
import {
  openAiError,
  type ChatStreamInput,
  type ChatStreamWriter,
  type ChatWire,
  type CompletionInput,
} from "./wire";

export const responsesWire: ChatWire = {
  error: openAiError,
  complete: responseBody,
  stream: responsesStream,
};

type Usage = {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly total_tokens: number;
  readonly input_tokens_details: { readonly cached_tokens: number };
};

type OutputTextPart = {
  readonly type: "output_text";
  readonly text: string;
  readonly annotations: readonly [];
};

type MessageItem = {
  readonly id: string;
  readonly type: "message";
  readonly status: "in_progress" | "completed";
  readonly role: "assistant";
  readonly content: readonly OutputTextPart[];
};

type FunctionCallItem = {
  readonly id: string;
  readonly type: "function_call";
  readonly status: "in_progress" | "completed";
  readonly call_id: string;
  readonly name: string;
  readonly arguments: string;
};

type OutputItem = MessageItem | FunctionCallItem;

type CallState = {
  readonly index: number;
  readonly itemId: string;
  readonly callId: string;
  readonly name: string;
  readonly arguments: string;
};

function responseBody({ id, created, model, result }: CompletionInput): Response {
  const message = messageItem(id, result.text, "completed");

  const calls = result.toolCalls.map((call): OutputItem => ({
    id: callItemId(call.id),
    type: "function_call",
    status: "completed",
    call_id: call.id,
    name: call.name,
    arguments: call.arguments,
  }));

  return Response.json(
    {
      id: responseIdOf(id),
      object: "response",
      created_at: created,
      status: statusOf(result.finishReason),
      model,
      output: result.text !== "" || calls.length === 0 ? [message, ...calls] : calls,
      usage: usageOf(result.usage),
      error: null,
      incomplete_details: incompleteOf(result.finishReason),
    },
    { headers: { "cache-control": "no-store" } },
  );
}

function responsesStream({ id, created, model, sink }: ChatStreamInput): ChatStreamWriter {
  const responseId = responseIdOf(id);
  const calls = new Map<string, CallState>();
  let started = false;
  let sequence = 0;
  let nextIndex = 0;
  let messageIndex: number | null = null;
  let fullText = "";

  const send = (event: { readonly [key: string]: JsonValue }) => {
    sink.send("data: " + JSON.stringify({ ...event, sequence_number: sequence++ }) + "\n\n");
  };

  const responseOf = (detail: { readonly [key: string]: JsonValue }) => ({
    id: responseId,
    object: "response",
    created_at: created,
    model,
    output: [],
    ...detail,
  });

  const start = () => {
    if (started) return;

    started = true;
    send({ type: "response.created", response: responseOf({ status: "in_progress" }) });
  };

  const openMessage = (): number => {
    start();

    if (messageIndex !== null) return messageIndex;

    messageIndex = nextIndex++;

    send({
      type: "response.output_item.added",
      output_index: messageIndex,
      item: messageItem(id, "", "in_progress"),
    });
    send({
      type: "response.content_part.added",
      output_index: messageIndex,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });

    return messageIndex;
  };

  const closeMessage = () => {
    const index = messageIndex;

    if (index === null) return;

    const done = messageItem(id, fullText, "completed");
    const part: OutputTextPart = { type: "output_text", text: fullText, annotations: [] };

    send({
      type: "response.output_text.done",
      output_index: index,
      content_index: 0,
      text: fullText,
    });
    send({ type: "response.content_part.done", output_index: index, content_index: 0, part });
    send({ type: "response.output_item.done", output_index: index, item: done });
  };

  const closeCall = (state: CallState) => {
    send({
      type: "response.function_call_arguments.done",
      output_index: state.index,
      item_id: state.itemId,
      arguments: state.arguments,
    });
    send({
      type: "response.output_item.done",
      output_index: state.index,
      item: callItem(state, "completed"),
    });
  };

  const output = (): readonly OutputItem[] => {
    const items: { readonly index: number; readonly item: OutputItem }[] = [];

    if (messageIndex !== null)
      items.push({ index: messageIndex, item: messageItem(id, fullText, "completed") });

    for (const state of calls.values())
      items.push({ index: state.index, item: callItem(state, "completed") });

    return items.sort((left, right) => left.index - right.index).map((entry) => entry.item);
  };

  return {
    get started() {
      return started;
    },

    text(chunk) {
      const index = openMessage();

      fullText += chunk;
      send({
        type: "response.output_text.delta",
        output_index: index,
        content_index: 0,
        delta: chunk,
      });
    },

    toolCall(call) {
      start();

      if (calls.has(call.id)) return;

      const state: CallState = {
        index: nextIndex++,
        itemId: callItemId(call.id),
        callId: call.id,
        name: call.name,
        arguments: "",
      };

      calls.set(call.id, state);

      send({
        type: "response.output_item.added",
        output_index: state.index,
        item: callItem(state, "in_progress"),
      });
    },

    toolArguments(callId, delta) {
      const known = calls.get(callId);

      if (known === undefined) throw new Error("no tool call " + callId + " was announced");

      const state: CallState = { ...known, arguments: known.arguments + delta };

      calls.set(callId, state);

      send({
        type: "response.function_call_arguments.delta",
        output_index: state.index,
        item_id: state.itemId,
        delta,
      });
    },

    finish(reason, usage) {
      start();

      if (messageIndex === null && calls.size === 0) openMessage();

      closeMessage();

      for (const state of calls.values()) closeCall(state);

      send({
        type: "response.completed",
        response: responseOf({
          status: statusOf(reason),
          output: output(),
          usage: usageOf(usage),
          error: null,
          incomplete_details: incompleteOf(reason),
        }),
      });
      sink.send("data: [DONE]\n\n");
      sink.close();
    },

    fail(message, code) {
      start();
      send({
        type: "response.failed",
        response: responseOf({
          status: "failed",
          error: { code, message, type: "upstream_error" },
        }),
      });
      sink.send("data: [DONE]\n\n");
      sink.close();
    },
  };
}

function responseIdOf(id: string): string {
  return "resp_" + id.replaceAll("-", "");
}

function callItemId(callId: string): string {
  return "fc_" + callId;
}

function messageItem(id: string, text: string, status: "in_progress" | "completed"): MessageItem {
  return {
    id: "msg_" + id,
    type: "message",
    status,
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

function callItem(state: CallState, status: "in_progress" | "completed"): FunctionCallItem {
  return {
    id: state.itemId,
    type: "function_call",
    status,
    call_id: state.callId,
    name: state.name,
    arguments: state.arguments,
  };
}

function statusOf(reason: string | null): "completed" | "incomplete" {
  return reason === "length" ? "incomplete" : "completed";
}

function incompleteOf(reason: string | null): { readonly reason: "max_output_tokens" } | null {
  return reason === "length" ? { reason: "max_output_tokens" } : null;
}

function usageOf(usage: CanonicalUsage): Usage {
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;

  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: input + output,
    input_tokens_details: { cached_tokens: usage.cachedInputTokens ?? 0 },
  };
}
