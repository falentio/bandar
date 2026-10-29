import { Elysia } from "elysia";
import * as v from "valibot";
import { GatewayRequestSchema, type ModelList } from "../shared/chat";
import {
  MessagesRequestSchema,
  normalizeMessages,
  promptText,
  type MessagesRequest,
  type NormalizedMessages,
} from "../shared/messages";
import { PROJECT_URL_HEADER, projectUrlOf } from "../shared/project";
import { SESSION_ID_HEADER, sessionIdOf } from "../shared/session-id";
import type { Auth, VerifiedKey } from "./auth";
import type { CanonicalMessage, CanonicalRequest } from "./providers/types";
import { anthropicError, anthropicWire, estimateInputTokens } from "./router/anthropic-wire";
import { runChat, type ChatDeps } from "./router/chat";
import { listModelRefs } from "./router/resolve";
import { openAiError } from "./router/wire";
import { issueText } from "./validation";

const MESSAGES_PATH = "/v1/messages";

export type GatewayDeps = ChatDeps & {
  readonly auth: Auth;
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
        const issue = parsed.issues[0];
        const note = issue === undefined ? null : issueText(issue);

        return openAiError(
          422,
          note?.message ?? "request did not match the schema",
          "validation",
          "invalid_request_error",
          note?.param ?? null,
        );
      }

      const caller = await callerOf(deps.auth, request);

      if (caller === null) return unauthorized();

      const input = parsed.output;

      const canonical: CanonicalRequest = {
        messages: input.messages,
        temperature: input.temperature,
        topP: input.topP,
        maxTokens: input.maxTokens,
        stop: input.stop,
      };

      return runChat(deps, {
        userId: caller.userId,
        apiKeyId: caller.keyId,
        projectUrl: projectUrlOf(request.headers.get(PROJECT_URL_HEADER)),
        sessionId: sessionIdOf(request.headers.get(SESSION_ID_HEADER)),
        ref: input.model,
        request: canonical,
        stream: input.stream,
        signal: request.signal,
      });
    })
    .post("/messages", async ({ body, request }) => {
      const parsed = v.safeParse(MessagesRequestSchema, body);

      if (!parsed.success) {
        const issue = parsed.issues[0];

        return anthropicError(
          422,
          issue === undefined ? "request did not match the schema" : issueText(issue).message,
        );
      }

      const caller = await callerOf(deps.auth, request);

      if (caller === null) return anthropicUnauthorized();

      const normalized = normalizeMessages(parsed.output);

      if (!normalized.ok)
        return anthropicError(normalized.rejection.status, normalized.rejection.message);

      return runChat(deps, {
        userId: caller.userId,
        apiKeyId: caller.keyId,
        projectUrl: projectUrlOf(request.headers.get(PROJECT_URL_HEADER)),
        sessionId: sessionIdOf(request.headers.get(SESSION_ID_HEADER)),
        ref: parsed.output.model,
        request: canonicalRequestOf(parsed.output, normalized.value),
        stream: parsed.output.stream ?? false,
        signal: request.signal,
        wire: anthropicWire,
      });
    })
    .post("/messages/count_tokens", async ({ body, request }) => {
      const parsed = v.safeParse(MessagesRequestSchema, body);

      if (!parsed.success) {
        const issue = parsed.issues[0];

        return anthropicError(
          422,
          issue === undefined ? "request did not match the schema" : issueText(issue).message,
        );
      }

      const caller = await callerOf(deps.auth, request);

      if (caller === null) return anthropicUnauthorized();

      const normalized = normalizeMessages(parsed.output);

      if (!normalized.ok)
        return anthropicError(normalized.rejection.status, normalized.rejection.message);

      return Response.json(
        { input_tokens: estimateInputTokens(promptText(normalized.value)) },
        { headers: { "cache-control": "no-store" } },
      );
    });
}

function canonicalRequestOf(
  request: MessagesRequest,
  normalized: NormalizedMessages,
): CanonicalRequest {
  const messages: CanonicalMessage[] = [];

  if (normalized.system !== "") messages.push({ role: "system", content: normalized.system });

  for (const message of normalized.messages)
    messages.push({ role: message.role, content: message.text });

  return {
    messages,
    temperature: request.temperature,
    topP: request.top_p,
    maxTokens: request.max_tokens,
    stop: request.stop_sequences,
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
