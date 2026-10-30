import * as v from "valibot";
import { textOfParts } from "../../../shared/conversation";
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
import type {
  AdapterInput,
  CanonicalResult,
  CanonicalStreamEvent,
  CanonicalUsage,
  ProviderAdapter,
} from "../types";

const UsageSchema = v.object({
  input_tokens: v.optional(v.nullable(v.number())),
  output_tokens: v.optional(v.nullable(v.number())),
});

const ErrorSchema = v.object({ message: v.optional(v.string()) });

const OutputSchema = v.object({
  type: v.string(),
  content: v.optional(
    v.array(v.object({ type: v.string(), text: v.optional(v.nullable(v.string())) })),
  ),
});

const ResponseSchema = v.object({
  output: v.array(OutputSchema),
  status: v.optional(v.nullable(v.string())),
  incomplete_details: v.optional(
    v.nullable(v.object({ reason: v.optional(v.nullable(v.string())) })),
  ),
  usage: v.optional(v.nullable(UsageSchema)),
  error: v.optional(v.nullable(ErrorSchema)),
});

const EventSchema = v.object({
  type: v.string(),
  delta: v.optional(v.nullable(v.string())),
  response: v.optional(ResponseSchema),
  error: v.optional(ErrorSchema),
  message: v.optional(v.string()),
});

type InputItem = {
  role: "system" | "user" | "assistant";
  content: { type: "input_text"; text: string }[];
};

type ResponsesBody = {
  model: string;
  input: InputItem[];
  stream?: boolean;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
};

export type ResponsesOptions<K extends ProviderKind> = {
  readonly kind: K;
  readonly label: string;
  readonly headers: HeaderFactory;
};

export function responsesAdapter<K extends ProviderKind>({
  kind,
  label,
  headers: headersOf,
}: ResponsesOptions<K>): ProviderAdapter<K> {
  return {
    kind,

    async chat(input: AdapterInput): Promise<CanonicalResult> {
      const response = await postJson({
        url: joinUrl(input.target.baseUrl, "/responses"),
        headers: headersOf(input.target.credential),
        body: JSON.stringify(bodyFor(input, false)),
        signal: input.signal,
      });

      await requireOk(response);

      const parsed = v.safeParse(ResponseSchema, await response.json());

      if (!parsed.success) throw protocolError(`${label} returned an unexpected response shape`);

      const failure = failureOf(parsed.output, label);

      if (failure !== null) throw protocolError(failure);

      return {
        text: textOf(parsed.output.output),
        toolCalls: [],
        finishReason: finishReason(parsed.output.status ?? null, reasonOf(parsed.output)),
        usage: usageOf(parsed.output.usage),
      };
    },

    async *stream(input: AdapterInput): AsyncGenerator<CanonicalStreamEvent, void, void> {
      const response = await postJson({
        url: joinUrl(input.target.baseUrl, "/responses"),
        headers: headersOf(input.target.credential),
        body: JSON.stringify(bodyFor(input, true)),
        signal: input.signal,
      });

      await requireOk(response);

      let reason: string | null = null;
      let usage: CanonicalUsage | null = null;

      for await (const data of sseData(requireBody(response), input.signal)) {
        if (data === "[DONE]") break;

        const event = parseEvent(data);

        if (event === null) continue;

        switch (event.type) {
          case "response.output_text.delta": {
            if (event.delta !== undefined && event.delta !== null && event.delta !== "") {
              yield { type: "text", text: event.delta };
            }

            break;
          }

          case "response.completed":
          case "response.incomplete": {
            const result = event.response;

            if (result === undefined) break;

            if (result.usage !== undefined && result.usage !== null) {
              usage = usageOf(result.usage);
            }

            const status =
              result.status ?? (event.type === "response.completed" ? "completed" : "incomplete");

            reason = finishReason(status, reasonOf(result));
            break;
          }

          case "response.failed": {
            throw protocolError(event.response?.error?.message ?? `${label} stream failed`);
          }

          case "error": {
            throw protocolError(
              event.error?.message ?? event.message ?? `${label} stream returned an error`,
            );
          }

          default: {
            break;
          }
        }
      }

      if (usage !== null) yield { type: "usage", usage };

      yield { type: "finish", reason };
    },
  };
}

function bodyFor(input: AdapterInput, stream: boolean): ResponsesBody {
  const body: ResponsesBody = {
    model: input.target.upstreamModel,
    input: input.request.messages.map((message) => ({
      role: message.role,
      content: [{ type: "input_text", text: textOfParts(message.content) }],
    })),
  };

  if (stream) body.stream = true;

  if (input.request.temperature !== undefined) body.temperature = input.request.temperature;

  if (input.request.topP !== undefined) body.top_p = input.request.topP;

  if (input.request.maxTokens !== undefined) body.max_output_tokens = input.request.maxTokens;

  return body;
}

function parseEvent(data: string): v.InferOutput<typeof EventSchema> | null {
  try {
    const parsed = v.safeParse(EventSchema, JSON.parse(data));

    return parsed.success ? parsed.output : null;
  } catch {
    return null;
  }
}

function textOf(output: readonly v.InferOutput<typeof OutputSchema>[]): string {
  const parts: string[] = [];

  for (const item of output) {
    if (item.type !== "message") continue;

    for (const part of item.content ?? []) {
      if (part.type === "output_text") parts.push(part.text ?? "");
    }
  }

  return parts.join("");
}

function reasonOf(response: v.InferOutput<typeof ResponseSchema>): string | null {
  return response.incomplete_details?.reason ?? null;
}

/** A 200 is not a success on this wire: a failed response carries its error in the body. */
function failureOf(response: v.InferOutput<typeof ResponseSchema>, label: string): string | null {
  if (response.status === "failed") {
    return response.error?.message ?? `${label} returned a failed response`;
  }

  if (response.output.length > 0) return null;

  return response.error?.message ?? null;
}

function usageOf(usage: v.InferOutput<typeof UsageSchema> | null | undefined): CanonicalUsage {
  return {
    inputTokens: usage?.input_tokens ?? null,
    outputTokens: usage?.output_tokens ?? null,
  };
}

function finishReason(status: string | null, reason: string | null): string | null {
  if (status === "completed") return "stop";

  if (status === "incomplete" && reason === "max_output_tokens") return "length";

  return reason;
}
