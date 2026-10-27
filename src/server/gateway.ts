import { type AnyElysia, Elysia } from "elysia";
import * as v from "valibot";
import { GatewayRequestSchema, type ModelList } from "../shared/chat";
import type { Auth, VerifiedKey } from "./auth";
import { listModelAliases } from "./providers";
import { runChat, type ChatDeps } from "./router/chat";
import type { CanonicalRequest } from "./router/types";
import { openAiError } from "./router/wire";

export type GatewayDeps = ChatDeps & {
  readonly auth: Auth;
};

export function createGateway(deps: GatewayDeps): AnyElysia {
  return new Elysia({ prefix: "/v1" })
    .onError(({ code, error, path }) => {
      if (code === "NOT_FOUND") return openAiError(404, `no route for ${path}`, "not_found");

      console.error("gateway: unhandled error", error);

      return openAiError(500, "unexpected server error", "internal", "server_error");
    })
    .get("/models", async ({ request }) => {
      const caller = await callerOf(deps.auth, request);

      if (caller === null) return unauthorized();

      const aliases = await listModelAliases(deps.providers, caller.userId);

      const body: ModelList = {
        object: "list",
        data: aliases.map((model) => ({
          id: model.alias,
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

        return openAiError(
          422,
          issue === undefined ? "request did not match the schema" : issue.message,
          "validation",
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
        alias: input.model,
        request: canonical,
        stream: input.stream,
        signal: request.signal,
      });
    });
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
