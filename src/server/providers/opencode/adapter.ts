import { anthropicAdapter } from "../anthropic/adapter";
import { googleAdapter } from "../google/adapter";
import { bearerHeaders, joinUrl } from "../http";
import { chatAdapter } from "../openai/compatible";
import { responsesAdapter } from "../openai/responses";
import {
  UpstreamError,
  type AdapterInput,
  type ProviderAdapter,
  type ProviderTarget,
} from "../types";
import { gapMessage, opencodeModelOf, type OpenCodeWire } from "./models";

type OpenCodeRoute = {
  readonly mount: string;
  readonly adapter: ProviderAdapter<"opencode">;
};

/** Every path opencode serves, under one base URL. */
export const OPENCODE_MOUNTS = {
  models: "/go/v1",
  openai: "/go/openai/v1",
  responses: "/go/openai/v1",
  anthropic: "/go/anthropic/v1",
  google: "/go/google/v1beta",
} as const;

const ROUTES: Record<OpenCodeWire, OpenCodeRoute> = {
  openai: {
    mount: OPENCODE_MOUNTS.openai,
    adapter: chatAdapter({
      kind: "opencode",
      label: "opencode go (openai)",
      headers: bearerHeaders,
    }),
  },
  responses: {
    mount: OPENCODE_MOUNTS.responses,
    adapter: responsesAdapter({
      kind: "opencode",
      label: "opencode go (responses)",
      headers: bearerHeaders,
    }),
  },
  anthropic: {
    mount: OPENCODE_MOUNTS.anthropic,
    adapter: anthropicAdapter({
      kind: "opencode",
      label: "opencode go (anthropic)",
      headers: bearerHeaders,
    }),
  },
  google: {
    mount: OPENCODE_MOUNTS.google,
    adapter: googleAdapter({
      kind: "opencode",
      label: "opencode go (google)",
      headers: bearerHeaders,
    }),
  },
};

export const opencodeAdapter: ProviderAdapter<"opencode"> = {
  kind: "opencode",

  chat(input: AdapterInput) {
    const route = routeFor(input.target.upstreamModel);

    return route.adapter.chat({ ...input, target: mounted(input.target, route.mount) });
  },

  async *stream(input: AdapterInput) {
    const route = routeFor(input.target.upstreamModel);

    yield* route.adapter.stream({ ...input, target: mounted(input.target, route.mount) });
  },
};

/** The wire for a model, or a 400 before any request leaves the process. */
function routeFor(upstreamModel: string): OpenCodeRoute {
  const model = opencodeModelOf(upstreamModel);

  if (model === undefined) {
    throw new UpstreamError(`opencode go does not list ${upstreamModel}`, "invalid_request");
  }

  if (model.wire === null) {
    throw new UpstreamError(gapMessage(model.gap, upstreamModel), "invalid_request");
  }

  return ROUTES[model.wire];
}

function mounted(target: ProviderTarget, mount: string): ProviderTarget {
  return { ...target, baseUrl: joinUrl(target.baseUrl, mount) };
}
