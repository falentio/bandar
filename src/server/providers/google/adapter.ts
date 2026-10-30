import * as v from "valibot";
import {
  textOfParts,
  toolNamesOf,
  toolResultText,
  type MessagePart,
  type ToolCall,
  type ToolChoice,
  type ToolDefinition,
  type ToolParameters,
  type ToolResult,
} from "../../../shared/conversation";
import type { ProviderKind } from "../../../shared/providers";
import {
  joinUrl,
  postJson,
  protocolError,
  requireBody,
  requireOk,
  sseData,
  type HeaderFactory,
} from "../http";
import {
  UpstreamError,
  finishOf,
  jsonObjectOf,
  type AdapterInput,
  type CanonicalMessage,
  type CanonicalResult,
  type CanonicalStreamEvent,
  type CanonicalUsage,
  type ProviderAdapter,
} from "../types";

const UsageSchema = v.object({
  promptTokenCount: v.optional(v.nullable(v.number())),
  candidatesTokenCount: v.optional(v.nullable(v.number())),
});

const PartSchema = v.object({
  text: v.optional(v.nullable(v.string())),
  functionCall: v.optional(
    v.nullable(
      v.object({
        name: v.string(),
        args: v.optional(v.nullable(v.record(v.string(), v.unknown()))),
      }),
    ),
  ),
});

type Part = v.InferOutput<typeof PartSchema>;

const CandidateSchema = v.object({
  content: v.optional(v.object({ parts: v.optional(v.array(PartSchema)) })),
  finishReason: v.optional(v.nullable(v.string())),
});

const ResponseSchema = v.object({
  candidates: v.optional(v.array(CandidateSchema)),
  usageMetadata: v.optional(v.nullable(UsageSchema)),
  error: v.optional(v.object({ message: v.optional(v.string()) })),
});

type RequestPart =
  | { text: string }
  | { functionCall: { name: string; args: ToolParameters } }
  | { functionResponse: { name: string; response: ToolParameters } };

type Content = { role: "user" | "model"; parts: RequestPart[] };

type FunctionDeclaration = {
  name: string;
  description?: string;
  parameters: ToolParameters;
};

type ChatBody = {
  contents: Content[];
  systemInstruction?: { parts: { text: string }[] };
  generationConfig?: {
    temperature?: number;
    topP?: number;
    maxOutputTokens?: number;
    stopSequences?: string[];
  };
  tools?: { functionDeclarations: FunctionDeclaration[] }[];
  toolConfig?: {
    functionCallingConfig: { mode: "AUTO" | "ANY" | "NONE"; allowedFunctionNames?: string[] };
  };
};

export type GoogleOptions<K extends ProviderKind> = {
  readonly kind: K;
  readonly label: string;
  readonly headers: HeaderFactory;
};

export function googleAdapter<K extends ProviderKind>({
  kind,
  label,
  headers: headersOf,
}: GoogleOptions<K>): ProviderAdapter<K> {
  return {
    kind,

    async chat(input: AdapterInput): Promise<CanonicalResult> {
      const response = await postJson({
        url: chatUrl(input, false),
        headers: headersOf(input.target.credential),
        body: JSON.stringify(bodyFor(input)),
        signal: input.signal,
      });

      await requireOk(response);

      const parsed = v.safeParse(ResponseSchema, await response.json());

      if (!parsed.success) throw protocolError(`${label} returned an unexpected response shape`);

      const candidate = parsed.output.candidates?.[0];

      if (candidate === undefined) throw protocolError(`${label} returned no candidates`);

      const calls = callsOf(partsOf(candidate));

      return {
        text: textOf(candidate),
        toolCalls: calls,
        finishReason: finishOf(finishReason(candidate.finishReason ?? null), calls),
        usage: usageOf(parsed.output.usageMetadata),
      };
    },

    async *stream(input: AdapterInput): AsyncGenerator<CanonicalStreamEvent, void, void> {
      const response = await postJson({
        url: chatUrl(input, true),
        headers: headersOf(input.target.credential),
        body: JSON.stringify(bodyFor(input)),
        signal: input.signal,
      });

      await requireOk(response);

      let reason: string | null = null;
      let usage: CanonicalUsage | null = null;
      const calls: ToolCall[] = [];

      for await (const data of sseData(requireBody(response), input.signal)) {
        let parsed: v.InferOutput<typeof ResponseSchema>;

        try {
          const result = v.safeParse(ResponseSchema, JSON.parse(data));

          if (!result.success) continue;

          parsed = result.output;
        } catch {
          continue;
        }

        if (parsed.error !== undefined) {
          throw protocolError(parsed.error.message ?? `${label} stream returned an error`);
        }

        if (parsed.usageMetadata !== undefined && parsed.usageMetadata !== null) {
          usage = usageOf(parsed.usageMetadata);
        }

        const candidate = parsed.candidates?.[0];

        if (candidate === undefined) continue;

        for (const part of partsOf(candidate)) {
          if (part.text !== undefined && part.text !== null && part.text !== "") {
            yield { type: "text", text: part.text };
            continue;
          }

          const functionCall = part.functionCall;

          if (functionCall === undefined || functionCall === null) continue;

          const call = callOf(functionCall, calls.length);

          calls.push(call);
          yield { type: "tool_call_start", call: { id: call.id, name: call.name } };
          yield { type: "tool_call_delta", id: call.id, arguments: call.arguments };
        }

        if (candidate.finishReason !== undefined && candidate.finishReason !== null) {
          reason = finishReason(candidate.finishReason);
        }
      }

      if (usage !== null) yield { type: "usage", usage };

      yield { type: "finish", reason: finishOf(reason, calls) };
    },
  };
}

function chatUrl(input: AdapterInput, stream: boolean): string {
  const method = stream ? "streamGenerateContent" : "generateContent";
  const query = stream ? "?alt=sse" : "";

  return joinUrl(
    input.target.baseUrl,
    `/models/${encodeURIComponent(input.target.upstreamModel)}:${method}${query}`,
  );
}

function bodyFor(input: AdapterInput): ChatBody {
  const contents = contentsOf(input.request.messages);

  const system = input.request.messages
    .filter((message) => message.role === "system")
    .map((message) => textOfParts(message.content))
    .join("\n\n");

  if (contents.length === 0) {
    throw new UpstreamError(
      "google needs at least one user or assistant message",
      "invalid_request",
    );
  }

  const body: ChatBody = { contents };

  if (system !== "") body.systemInstruction = { parts: [{ text: system }] };

  const config: NonNullable<ChatBody["generationConfig"]> = {};

  if (input.request.temperature !== undefined) config.temperature = input.request.temperature;

  if (input.request.topP !== undefined) config.topP = input.request.topP;

  if (input.request.maxTokens !== undefined) config.maxOutputTokens = input.request.maxTokens;

  if (input.request.stop !== undefined) config.stopSequences = [...input.request.stop];

  if (Object.keys(config).length > 0) body.generationConfig = config;

  if (input.request.tools.length > 0)
    body.tools = [{ functionDeclarations: input.request.tools.map(declarationOf) }];

  if (input.request.toolChoice !== null) body.toolConfig = toolConfigOf(input.request.toolChoice);

  return body;
}

function contentsOf(messages: readonly CanonicalMessage[]): Content[] {
  const names = toolNamesOf(messages);
  const contents: Content[] = [];

  for (const message of messages) {
    if (message.role === "system") continue;

    const role: Content["role"] = message.role === "assistant" ? "model" : "user";
    const last = contents.at(-1);
    const turn: Content = last?.role === role ? last : { role, parts: [] };

    if (last?.role !== role) contents.push(turn);

    for (const part of message.content) turn.parts.push(requestPartOf(part, names));
  }

  return contents;
}

function requestPartOf(part: MessagePart, names: ReadonlyMap<string, string>): RequestPart {
  switch (part.type) {
    case "text": {
      return { text: part.text };
    }

    case "tool_call": {
      return {
        functionCall: {
          name: part.call.name,
          args: jsonObjectOf(part.call, "invalid_request"),
        },
      };
    }

    case "tool_result": {
      return {
        functionResponse: {
          name: nameOf(names, part.result),
          response: { result: toolResultText(part.result) },
        },
      };
    }
  }
}

/** This wire addresses a result by name, so a call the history never made cannot be answered. */
function nameOf(names: ReadonlyMap<string, string>, result: ToolResult): string {
  const name = names.get(result.toolCallId);

  if (name === undefined)
    throw new UpstreamError(
      "google cannot address the tool result for call " +
        result.toolCallId +
        ": no earlier turn called it",
      "invalid_request",
    );

  return name;
}

function declarationOf(tool: ToolDefinition): FunctionDeclaration {
  const declaration: FunctionDeclaration = { name: tool.name, parameters: tool.parameters };

  if (tool.description !== null) declaration.description = tool.description;

  return declaration;
}

function toolConfigOf(choice: ToolChoice): NonNullable<ChatBody["toolConfig"]> {
  switch (choice.mode) {
    case "auto": {
      return { functionCallingConfig: { mode: "AUTO" } };
    }

    case "none": {
      return { functionCallingConfig: { mode: "NONE" } };
    }

    case "required": {
      return { functionCallingConfig: { mode: "ANY" } };
    }

    case "tool": {
      return { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [choice.name] } };
    }
  }
}

function partsOf(candidate: v.InferOutput<typeof CandidateSchema>): readonly Part[] {
  return candidate.content?.parts ?? [];
}

function textOf(candidate: v.InferOutput<typeof CandidateSchema>): string {
  return partsOf(candidate)
    .map((part) => part.text ?? "")
    .join("");
}

function callsOf(parts: readonly Part[]): readonly ToolCall[] {
  const calls: ToolCall[] = [];

  for (const part of parts) {
    if (part.functionCall === undefined || part.functionCall === null) continue;

    calls.push(callOf(part.functionCall, calls.length));
  }

  return calls;
}

/** This wire carries no call id, so one is minted here; a result travels back by name. */
function callOf(call: NonNullable<Part["functionCall"]>, index: number): ToolCall {
  return {
    id: "call_" + String(index),
    name: call.name,
    arguments: JSON.stringify(call.args ?? {}),
  };
}

function usageOf(usage: v.InferOutput<typeof UsageSchema> | null | undefined): CanonicalUsage {
  return {
    inputTokens: usage?.promptTokenCount ?? null,
    outputTokens: usage?.candidatesTokenCount ?? null,
  };
}

function finishReason(value: string | null): string | null {
  switch (value) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
      return "content_filter";
    default:
      return value === null ? null : value.toLowerCase();
  }
}
