import type { Compat } from "../../../shared/providers";
import { anthropicAdapter } from "../anthropic/adapter";
import { googleAdapter } from "../google/adapter";
import { bearerHeaders } from "../http";
import { chatAdapter } from "../openai/compatible";
import { responsesAdapter } from "../openai/responses";
import type { CompatChoice, WireRoute } from "../types";
import { gapMessage, opencodeModelOf } from "./models";

/** Every path opencode serves, under one base URL. */
export const OPENCODE_MOUNTS = {
  models: "/go/v1",
  chat: "/go/openai/v1",
  responses: "/go/openai/v1",
  messages: "/go/anthropic/v1",
  genai: "/go/google/v1beta",
} as const;

/** A total record, so a new compat fails to compile until its mount and adapter are named. */
export const OPENCODE_ROUTES: Record<Compat, WireRoute<"opencode">> = {
  chat: {
    adapter: chatAdapter({
      kind: "opencode",
      label: "opencode go (openai)",
      headers: bearerHeaders,
    }),
    mount: OPENCODE_MOUNTS.chat,
  },
  responses: {
    adapter: responsesAdapter({
      kind: "opencode",
      label: "opencode go (responses)",
      headers: bearerHeaders,
    }),
    mount: OPENCODE_MOUNTS.responses,
  },
  messages: {
    adapter: anthropicAdapter({
      kind: "opencode",
      label: "opencode go (anthropic)",
      headers: bearerHeaders,
    }),
    mount: OPENCODE_MOUNTS.messages,
  },
  genai: {
    adapter: googleAdapter({
      kind: "opencode",
      label: "opencode go (google)",
      headers: bearerHeaders,
    }),
    mount: OPENCODE_MOUNTS.genai,
  },
};

/** The wire the Go table names for a model, or a 400 before any request leaves the process. */
export function opencodeDefaultCompat(upstreamModel: string): CompatChoice {
  const model = opencodeModelOf(upstreamModel);

  if (model === undefined) {
    return { compat: null, reason: `opencode go does not list ${upstreamModel}` };
  }

  if (model.compat === null) return { compat: null, reason: gapMessage(model.gap, upstreamModel) };

  return { compat: model.compat };
}
