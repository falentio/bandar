import { Elysia } from "elysia";
import * as v from "valibot";
import { GatewayRequestSchema, normalizeChatMessages, type ModelList } from "../shared/chat";
import { MessagesRequestSchema, estimateTokens, normalizeMessages } from "../shared/messages";
import { ResponsesRequestSchema, normalizeResponses } from "../shared/responses";
import type { InboundMessage, ToolChoice, ToolDefinition } from "../shared/conversation";
import type { Normalized } from "../shared/messages";
import { PROJECT_URL_HEADER, projectUrlOf } from "../shared/project";
import { SESSION_ID_HEADER, sessionIdOf } from "../shared/session-id";
import type { Auth, VerifiedKey } from "./auth";
import type { CanonicalMessage, CanonicalRequest } from "./providers/types";
import type { Reasoning } from "../shared/reasoning";
import { anthropicError, anthropicWire } from "./router/anthropic-wire";
import { fetchImage } from "./media/fetch";
import { inlineImages, type MediaIo } from "./media/inline";
import { runChat, type ChatDeps } from "./router/chat";
import { listModelRefs } from "./router/resolve";
import { responsesWire } from "./router/responses-wire";
import { openAiError } from "./router/wire";
import { issueOf } from "./validation";

const MESSAGES_PATH = "/v1/messages";

export type GatewayDeps = ChatDeps & {
  readonly auth: Auth;
  /** How a remote image is read. The default fetcher is used unless a caller injects its own. */
  readonly media?: MediaIo;
};

export function createGateway(deps: GatewayDeps) {
  return new Elysia({ prefix: "/v1" })
    .onError(({ code, error, path }) => {
      const anthropic = path.startsWith(MESSAGES_PATH);

      if (code === "NOT_FOUND")
        return anthropic
          ? anthropicError(404, `no route for ${path}`)
          : openAiError(404, `no route for ${path}`, "not_found");

      console.error("gateway: unhandled error", error);

      return anthropic
        ? anthropicError(500, "unexpected server error")
        : openAiError(500, "unexpected server error", "internal", "server_error");
    })
    .get("/models", async ({ request }) => {
      const caller = await callerOf(deps.auth, request);

      if (caller === null) return unauthorized();

      const models = await listModelRefs(deps.providers, caller.userId);

      const body: ModelList = {
        object: "list",
        data: models.map((model) => ({
          id: model.id,
          object: "model",
          created: Math.floor(model.createdAt.getTime() / 1000),
          owned_by: "bandar",
        })),
      };

      return Response.json(body, {
        headers: { "cache-control": "no-store" },
      });
    })
    .post("/chat/completions", async ({ body, request }) => {
      const parsed = v.safeParse(GatewayRequestSchema, body);

      if (!parsed.success) {
        const text = issueOf(parsed.issues);

        return openAiError(422, text.message, "validation", "invalid_request_error", text.param);
      }

      const caller = await callerOf(deps.auth, request);

      if (caller === null) return unauthorized();

      const normalized = normalizeChatMessages(parsed.output.messages);

      if (!normalized.ok)
        return openAiError(
          normalized.rejection.status,
          normalized.rejection.message,
          "validation",
          "invalid_request_error",
          normalized.rejection.param,
        );

      const input = parsed.output;

      const canonical = await canonicalRequestOf(deps, normalized.value, request.signal, {
        system: "",
        tools: input.tools,
        toolChoice: input.toolChoice,
        temperature: input.temperature,
        topP: input.topP,
        maxTokens: input.maxTokens,
        stop: input.stop,
        reasoning: input.reasoning,
      });

      if (!canonical.ok)
        return openAiError(
          canonical.rejection.status,
          canonical.rejection.message,
          "validation",
          "invalid_request_error",
          canonical.rejection.param,
        );

      return runChat(deps, {
        userId: caller.userId,
        apiKeyId: caller.keyId,
        projectUrl: projectUrlOf(request.headers.get(PROJECT_URL_HEADER)),
        sessionId: sessionIdOf(request.headers.get(SESSION_ID_HEADER)),
        ref: input.model,
        request: canonical.value,
        stream: input.stream,
        signal: request.signal,
      });
    })
    .post("/responses", async ({ body, request }) => {
      const parsed = v.safeParse(ResponsesRequestSchema, body);

      if (!parsed.success) {
        const text = issueOf(parsed.issues);

        return openAiError(422, text.message, "validation", "invalid_request_error", text.param);
      }

      const caller = await callerOf(deps.auth, request);

      if (caller === null) return unauthorized();

      const normalized = normalizeResponses(parsed.output);

      if (!normalized.ok)
        return openAiError(
          normalized.rejection.status,
          normalized.rejection.message,
          "validation",
          "invalid_request_error",
          normalized.rejection.param,
        );

      const input = parsed.output;

      const canonical = await canonicalRequestOf(deps, normalized.value, request.signal, {
        system: input.instructions ?? "",
        tools: input.tools,
        toolChoice: input.toolChoice,
        temperature: input.temperature,
        topP: input.topP,
        maxTokens: input.maxOutputTokens,
        stop: input.stop,
        reasoning: input.reasoning,
      });

      if (!canonical.ok)
        return openAiError(
          canonical.rejection.status,
          canonical.rejection.message,
          "validation",
          "invalid_request_error",
          canonical.rejection.param,
        );

      return runChat(deps, {
        userId: caller.userId,
        apiKeyId: caller.keyId,
        projectUrl: projectUrlOf(request.headers.get(PROJECT_URL_HEADER)),
        sessionId: sessionIdOf(request.headers.get(SESSION_ID_HEADER)),
        ref: input.model,
        request: canonical.value,
        stream: input.stream,
        signal: request.signal,
        wire: responsesWire,
      });
    })
    .post("/messages", async ({ body, request }) => {
      const parsed = v.safeParse(MessagesRequestSchema, body);

      if (!parsed.success) return anthropicError(422, issueOf(parsed.issues).message);

      const caller = await callerOf(deps.auth, request);

      if (caller === null) return anthropicUnauthorized();

      const normalized = normalizeMessages(parsed.output);

      if (!normalized.ok)
        return anthropicError(normalized.rejection.status, normalized.rejection.message);

      const canonical = await canonicalRequestOf(deps, normalized.value.messages, request.signal, {
        system: normalized.value.system,
        tools: parsed.output.tools,
        toolChoice: parsed.output.toolChoice,
        temperature: parsed.output.temperature,
        topP: parsed.output.top_p,
        maxTokens: parsed.output.max_tokens,
        stop: parsed.output.stop_sequences,
        reasoning: parsed.output.reasoning,
      });

      if (!canonical.ok)
        return anthropicError(canonical.rejection.status, canonical.rejection.message);

      return runChat(deps, {
        userId: caller.userId,
        apiKeyId: caller.keyId,
        projectUrl: projectUrlOf(request.headers.get(PROJECT_URL_HEADER)),
        sessionId: sessionIdOf(request.headers.get(SESSION_ID_HEADER)),
        ref: parsed.output.model,
        request: canonical.value,
        stream: parsed.output.stream ?? false,
        signal: request.signal,
        wire: anthropicWire,
      });
    })
    .post("/messages/count_tokens", async ({ body, request }) => {
      const parsed = v.safeParse(MessagesRequestSchema, body);

      if (!parsed.success) return anthropicError(422, issueOf(parsed.issues).message);

      const caller = await callerOf(deps.auth, request);

      if (caller === null) return anthropicUnauthorized();

      const normalized = normalizeMessages(parsed.output);

      if (!normalized.ok)
        return anthropicError(normalized.rejection.status, normalized.rejection.message);

      return Response.json(
        { input_tokens: estimateTokens(normalized.value) },
        { headers: { "cache-control": "no-store" } },
      );
    });
}

/**
 * All three ingresses assemble their canonical request here, so none of them knows a wire. This is
 * the one crossing where an image is read: it runs once, before runChat, and never per attempt.
 */
async function canonicalRequestOf(
  deps: GatewayDeps,
  messages: readonly InboundMessage[],
  signal: AbortSignal,
  input: {
    readonly system: string;
    readonly tools: readonly ToolDefinition[];
    readonly toolChoice: ToolChoice | null;
    readonly temperature?: number | undefined;
    readonly topP?: number | undefined;
    readonly maxTokens?: number | undefined;
    readonly stop?: readonly string[] | undefined;
    readonly reasoning?: Reasoning | undefined;
  },
): Promise<Normalized<CanonicalRequest>> {
  const media = deps.media ?? { fetchImage };
  const inlined = await inlineImages(messages, media, signal);

  if (!inlined.ok) return inlined;

  const canonical: CanonicalMessage[] = [];

  if (input.system !== "")
    canonical.push({ role: "system", content: [{ type: "text", text: input.system }] });

  for (const message of inlined.value)
    canonical.push({ role: message.role, content: message.content });

  return {
    ok: true,
    value: {
      messages: canonical,
      tools: input.tools,
      toolChoice: input.toolChoice,
      temperature: input.temperature,
      topP: input.topP,
      maxTokens: input.maxTokens,
      stop: input.stop,
      reasoning: input.reasoning,
    },
  };
}

async function callerOf(auth: Auth, request: Request): Promise<VerifiedKey | null> {
  const key = apiKeyOf(request);

  return key === null ? null : auth.verifyApiKey(key);
}

function apiKeyOf(request: Request): string | null {
  const authorization = request.headers.get("authorization");

  if (authorization !== null) {
    const trimmed = authorization.trim();

    if (trimmed.toLowerCase().startsWith("bearer ")) {
      const key = trimmed.slice("bearer ".length).trim();

      if (key !== "") return key;
    }
  }

  const header = request.headers.get("x-api-key");

  return header === null || header.trim() === "" ? null : header.trim();
}

function unauthorized(): Response {
  return openAiError(
    401,
    "send an API key as Authorization: Bearer <key> or x-api-key",
    "unauthorized",
    "authentication_error",
  );
}

function anthropicUnauthorized(): Response {
  return anthropicError(401, "send an API key as x-api-key or Authorization: Bearer <key>");
}
