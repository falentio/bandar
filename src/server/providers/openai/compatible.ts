import * as v from "valibot";
import type { ProviderKind } from "../../../shared/providers";
import type { Credential } from "../../credential";
import {
  joinUrl,
  postJson,
  protocolError,
  requireBody,
  requireOk,
  secretOf,
  sseData,
} from "../http";
import type {
  AdapterInput,
  CanonicalRequest,
  CanonicalResult,
  CanonicalStreamEvent,
  CanonicalUsage,
  ProviderAdapter,
} from "../types";

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

export type WireHeaders = Readonly<Record<string, string>>;

export type CompatibleOptions<K extends ProviderKind> = {
  readonly kind: K;
  readonly label: string;
  readonly headers: (credential: Credential) => WireHeaders;
};

export function chatAdapter<K extends ProviderKind>({
  kind,
  label,
  headers: headersOf,
}: CompatibleOptions<K>): ProviderAdapter<K> {
  return {
    kind,

    async chat(input: AdapterInput): Promise<CanonicalResult> {
      const response = await postJson({
        url: joinUrl(input.target.baseUrl, "/chat/completions"),
        headers: headersOf(input.target.credential),
        body: JSON.stringify(bodyFor(input, false)),
        signal: input.signal,
      });

      await requireOk(response);

      const parsed = v.safeParse(ResponseSchema, await response.json());

      if (!parsed.success) throw protocolError(`${label} returned an unexpected response shape`);

      const choice = parsed.output.choices[0];

      if (choice === undefined) throw protocolError(`${label} returned no choices`);

      return {
        text: choice.message.content ?? "",
        finishReason: choice.finish_reason ?? null,
        usage: usageOf(parsed.output.usage),
      };
    },

    async *stream(input: AdapterInput): AsyncGenerator<CanonicalStreamEvent, void, void> {
      const response = await postJson({
        url: joinUrl(input.target.baseUrl, "/chat/completions"),
        headers: headersOf(input.target.credential),
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
          throw protocolError(chunk.error.message ?? `${label} stream returned an error`);
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
}

export function bearerAdapter<K extends ProviderKind>(
  kind: K,
  label: string = kind,
): ProviderAdapter<K> {
  return chatAdapter({ kind, label, headers: bearerHeaders });
}

function bearerHeaders(credential: Credential): WireHeaders {
  const secret = secretOf(credential);

  return secret === "" ? {} : { authorization: `Bearer ${secret}` };
}

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
