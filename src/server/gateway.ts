import { Elysia } from "elysia";
import * as v from "valibot";
import { GatewayRequestSchema, normalizeChatMessages, type ModelList } from "../shared/chat";
import {
  MessagesRequestSchema,
  normalizeMessages,
  promptText,
} from "../shared/messages";
import type {
  ConversationMessage,
  ToolChoice,
  ToolDefinition,
} from "../shared/conversation";
import { PROJECT_URL_HEADER, projectUrlOf } from "../shared/project";
import { SESSION_ID_HEADER, sessionIdOf } from "../shared/session-id";
import type { Auth, VerifiedKey } from "./auth";
import type { CanonicalMessage, CanonicalRequest } from "./providers/types";
import { anthropicError, anthropicWire, estimateInputTokens } from "./router/anthropic-wire";
import { runChat, type ChatDeps } from "./router/chat";
import { listModelRefs } from "./router/resolve";
import { openAiError } from "./router/wire";
import { issueOf } from "./validation";

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

      const canonical = canonicalRequestOf({
        messages: normalized.value,
        system: "",
        tools: input.tools,
        toolChoice: input.toolChoice,
        temperature: input.temperature,
        topP: input.topP,
        maxTokens: input.maxTokens,
        stop: input.stop,
      });

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

      if (!parsed.success) return anthropicError(422, issueOf(parsed.issues).message);

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
        request: canonicalRequestOf({
          messages: normalized.value.messages,
          system: normalized.value.system,
          tools: parsed.output.tools,
          toolChoice: parsed.output.toolChoice,
          temperature: parsed.output.temperature,
          topP: parsed.output.top_p,
          maxTokens: parsed.output.max_tokens,
          stop: parsed.output.stop_sequences,
        }),
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
        { input_tokens: estimateInputTokens(promptText(normalized.value)) },
        { headers: { "cache-control": "no-store" } },
      );
    });
}

/** Both ingresses assemble their canonical request here, so neither handler knows a wire. */
function canonicalRequestOf(input: {
  readonly messages: readonly ConversationMessage[];
  readonly system: string;
  readonly tools: readonly ToolDefinition[];
  readonly toolChoice: ToolChoice | null;
  readonly temperature?: number | undefined;
  readonly topP?: number | undefined;
  readonly maxTokens?: number | undefined;
  readonly stop?: readonly string[] | undefined;
}): CanonicalRequest {
  const messages: CanonicalMessage[] = [];

  if (input.system !== "")
    messages.push({ role: "system", content: [{ type: "text", text: input.system }] });

  for (const message of input.messages)
    messages.push({ role: message.role, content: message.content });

  return {
    messages,
    tools: input.tools,
    toolChoice: input.toolChoice,
    temperature: input.temperature,
    topP: input.topP,
    maxTokens: input.maxTokens,
    stop: input.stop,
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
