import * as v from "valibot";
import { joinUrl, postJson, protocolError, requireBody, requireOk, sseData } from "./http";
import {
  UpstreamError,
  type AdapterInput,
  type CanonicalRequest,
  type CanonicalResult,
  type CanonicalStreamEvent,
  type CanonicalUsage,
  type ProviderAdapter,
} from "../types";

export const KILO_MODELS_URL = "https://api.kilo.ai/api/gateway/models";

const UsageSchema = v.object({
  prompt_tokens: v.optional(v.nullable(v.number())),
  completion_tokens: v.optional(v.nullable(v.number())),
});

const ResponseSchema = v.object({
  choices: v.array(
    v.object({
      message: v.object({ content: v.optional(v.nullable(v.string())) }),
      finish_reason: v.optional(v.nullable(v.string())),
    }),
  ),
  usage: v.optional(v.nullable(UsageSchema)),
});

const ChunkSchema = v.object({
  choices: v.optional(
    v.array(
      v.object({
        delta: v.object({ content: v.optional(v.nullable(v.string())) }),
        finish_reason: v.optional(v.nullable(v.string())),
      }),
    ),
  ),
  usage: v.optional(v.nullable(UsageSchema)),
  error: v.optional(v.object({ message: v.optional(v.string()) })),
});

type ChatBody = {
  model: string;
  messages: CanonicalRequest["messages"];
  stream?: boolean;
  stream_options?: { include_usage: boolean };
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: readonly string[];
};

export const kilocode: ProviderAdapter = {
  kind: "kilocode",

  async chat(input: AdapterInput): Promise<CanonicalResult> {
    const response = await postJson({
      url: joinUrl(input.target.baseUrl, "/chat/completions"),
      headers: headersFor(input),
      body: JSON.stringify(bodyFor(input, false)),
      signal: input.signal,
    });

    await requireOk(response);

    const parsed = v.safeParse(ResponseSchema, await response.json());

    if (!parsed.success) throw protocolError("kilo code returned an unexpected response shape");

    const choice = parsed.output.choices[0];

    if (choice === undefined) throw protocolError("kilo code returned no choices");

    return {
      text: choice.message.content ?? "",
      finishReason: choice.finish_reason ?? null,
      usage: usageOf(parsed.output.usage),
    };
  },

  async *stream(input: AdapterInput): AsyncGenerator<CanonicalStreamEvent, void, void> {
    const response = await postJson({
      url: joinUrl(input.target.baseUrl, "/chat/completions"),
      headers: headersFor(input),
      body: JSON.stringify(bodyFor(input, true)),
      signal: input.signal,
    });

    await requireOk(response);

    let reason: string | null = null;
    let usage: CanonicalUsage | null = null;

    for await (const data of sseData(requireBody(response), input.signal)) {
      if (data === "[DONE]") break;

      const chunk = parseChunk(data);

      if (chunk === null) continue;

      if (chunk.error !== undefined) {
        throw protocolError(chunk.error.message ?? "kilo code stream returned an error");
      }

      if (chunk.usage !== undefined && chunk.usage !== null) usage = usageOf(chunk.usage);

      const choice = chunk.choices?.[0];

      if (choice === undefined) continue;

      if (
        choice.delta.content !== undefined &&
        choice.delta.content !== null &&
        choice.delta.content !== ""
      ) {
        yield { type: "text", text: choice.delta.content };
      }

      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        reason = choice.finish_reason;
      }
    }

    if (usage !== null) yield { type: "usage", usage };

    yield { type: "finish", reason };
  },
};

function bodyFor(input: AdapterInput, stream: boolean): ChatBody {
  const body: ChatBody = {
    model: input.target.upstreamModel,
    messages: input.request.messages,
    stream,
  };

  if (stream) body.stream_options = { include_usage: true };

  if (input.request.temperature !== undefined) body.temperature = input.request.temperature;

  if (input.request.topP !== undefined) body.top_p = input.request.topP;

  if (input.request.maxTokens !== undefined) body.max_tokens = input.request.maxTokens;

  if (input.request.stop !== undefined) body.stop = input.request.stop;

  return body;
}

function headersFor(input: AdapterInput) {
  const credential = input.target.credential;

  if (credential.authMode === "api-key") {
    return credential.apiKey === ""
      ? apiHeaders({})
      : apiHeaders({ authorization: `Bearer ${credential.apiKey}` });
  }

  if (credential.accessToken === "") {
    throw new UpstreamError("kilo code needs a connection before it can be called", "auth");
  }

  if (credential.organizationId === null) {
    return apiHeaders({ authorization: `Bearer ${credential.accessToken}` });
  }

  return apiHeaders({
    authorization: `Bearer ${credential.accessToken}`,
    "x-kilocode-organizationid": credential.organizationId,
  });
}

function apiHeaders(headers: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return headers;
}

function parseChunk(data: string): v.InferOutput<typeof ChunkSchema> | null {
  try {
    const parsed = v.safeParse(ChunkSchema, JSON.parse(data));

    return parsed.success ? parsed.output : null;
  } catch {
    return null;
  }
}

function usageOf(usage: v.InferOutput<typeof UsageSchema> | null | undefined): CanonicalUsage {
  return {
    inputTokens: usage?.prompt_tokens ?? null,
    outputTokens: usage?.completion_tokens ?? null,
  };
}
