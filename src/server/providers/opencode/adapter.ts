import { anthropicAdapter } from "../anthropic/adapter";
import { googleAdapter } from "../google/adapter";
import { bearerHeaders, joinUrl } from "../http";
import { chatAdapter } from "../openai/compatible";
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

const ROUTES: Record<OpenCodeWire, OpenCodeRoute> = {
  openai: {
    mount: "/go/openai/v1",
    adapter: chatAdapter({
      kind: "opencode",
      label: "opencode go (openai)",
      headers: bearerHeaders,
    }),
  },
  anthropic: {
    mount: "/go/anthropic/v1",
    adapter: anthropicAdapter({
      kind: "opencode",
      label: "opencode go (anthropic)",
      headers: bearerHeaders,
    }),
  },
  google: {
    mount: "/go/google/v1beta",
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
