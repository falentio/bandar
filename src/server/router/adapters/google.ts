import * as v from "valibot";
import {
  apiKeyHeader,
  joinUrl,
  postJson,
  protocolError,
  requireBody,
  requireOk,
  secretOf,
  sseData,
} from "./http";
import {
  UpstreamError,
  type AdapterInput,
  type CanonicalRequest,
  type CanonicalResult,
  type CanonicalStreamEvent,
  type CanonicalUsage,
  type ProviderAdapter,
} from "../types";

const UsageSchema = v.object({
  promptTokenCount: v.optional(v.nullable(v.number())),
  candidatesTokenCount: v.optional(v.nullable(v.number())),
});

const CandidateSchema = v.object({
  content: v.optional(
    v.object({
      parts: v.optional(v.array(v.object({ text: v.optional(v.nullable(v.string())) }))),
    }),
  ),
  finishReason: v.optional(v.nullable(v.string())),
});

const ResponseSchema = v.object({
  candidates: v.optional(v.array(CandidateSchema)),
  usageMetadata: v.optional(v.nullable(UsageSchema)),
  error: v.optional(v.object({ message: v.optional(v.string()) })),
});

type Content = { role: "user" | "model"; parts: { text: string }[] };

type ChatBody = {
  contents: Content[];
  systemInstruction?: { parts: { text: string }[] };
  generationConfig?: {
    temperature?: number;
    topP?: number;
    maxOutputTokens?: number;
    stopSequences?: string[];
  };
};

export const google: ProviderAdapter = {
  kind: "google",

  async chat(input: AdapterInput): Promise<CanonicalResult> {
    const response = await postJson({
      url: chatUrl(input, false),
      headers: headersFor(secretOf(input.target.credential)),
      body: JSON.stringify(bodyFor(input)),
      signal: input.signal,
    });

    await requireOk(response);

    const parsed = v.safeParse(ResponseSchema, await response.json());

    if (!parsed.success) throw protocolError("google returned an unexpected response shape");

    const candidate = parsed.output.candidates?.[0];

    if (candidate === undefined) throw protocolError("google returned no candidates");

    return {
      text: textOf(candidate),
      finishReason: finishReason(candidate.finishReason ?? null),
      usage: usageOf(parsed.output.usageMetadata),
    };
  },

  async *stream(input: AdapterInput): AsyncGenerator<CanonicalStreamEvent, void, void> {
    const response = await postJson({
      url: chatUrl(input, true),
      headers: headersFor(secretOf(input.target.credential)),
      body: JSON.stringify(bodyFor(input)),
      signal: input.signal,
    });

    await requireOk(response);

    let reason: string | null = null;
    let usage: CanonicalUsage | null = null;

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
        throw protocolError(parsed.error.message ?? "google stream returned an error");
      }

      if (parsed.usageMetadata !== undefined && parsed.usageMetadata !== null) {
        usage = usageOf(parsed.usageMetadata);
      }

      const candidate = parsed.candidates?.[0];

      if (candidate === undefined) continue;

      const text = textOf(candidate);

      if (text !== "") yield { type: "text", text };

      if (candidate.finishReason !== undefined && candidate.finishReason !== null) {
        reason = finishReason(candidate.finishReason);
      }
    }

    if (usage !== null) yield { type: "usage", usage };

    yield { type: "finish", reason };
  },
};

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
    .map((message) => message.content)
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

  return body;
}

function contentsOf(messages: CanonicalRequest["messages"]): Content[] {
  const contents: Content[] = [];

  for (const message of messages) {
    if (message.role === "system") continue;

    const role = message.role === "assistant" ? "model" : "user";
    const last = contents.at(-1);

    if (last !== undefined && last.role === role) {
      last.parts.push({ text: message.content });
    } else {
      contents.push({ role, parts: [{ text: message.content }] });
    }
  }

  return contents;
}

function headersFor(apiKey: string): Record<string, string> {
  return apiKeyHeader("x-goog-api-key", apiKey);
}

function textOf(candidate: v.InferOutput<typeof CandidateSchema>): string {
  return (candidate.content?.parts ?? []).map((part) => part.text ?? "").join("");
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
