import type { BuiltInProviderKind } from "../../shared/providers";

export type EndpointSpec = {
  readonly env: string;
  readonly default: string;
  readonly description: string;
};

export type EndpointSpecs = {
  readonly baseUrl: EndpointSpec;
  readonly catalogUrl?: EndpointSpec;
  readonly authUrl?: EndpointSpec;
};

export type EndpointField = keyof EndpointSpecs;

const baseUrl = (env: string, value: string): EndpointSpec => ({
  env,
  default: value,
  description: `The full API base URL, including the mount. Defaults to ${value}.`,
});

const catalogUrl = (env: string, value: string): EndpointSpec => ({
  env,
  default: value,
  description: `The model catalog URL. Defaults to ${value}.`,
});

const authUrl = (env: string, value: string): EndpointSpec => ({
  env,
  default: value,
  description: `The OAuth origin and prefix. Defaults to ${value}.`,
});

export const PROVIDER_ENDPOINT_SPECS = {
  kilocode: {
    baseUrl: baseUrl("BANDAR_KILOCODE_API", "https://api.kilo.ai/api/openrouter"),
    catalogUrl: catalogUrl("BANDAR_KILOCODE_MODELS_URL", "https://api.kilo.ai/api/gateway/models"),
  },
  tokenharbor: {
    baseUrl: baseUrl("BANDAR_TOKENHARBOR_API", "https://tokenharbor.ai/v1"),
  },
  yeta: {
    baseUrl: baseUrl("BANDAR_YETA_API", "https://platform.yeta.ai/v1"),
  },
  river: {
    baseUrl: baseUrl("BANDAR_RIVER_API", "https://api.river.ai/v1"),
    catalogUrl: catalogUrl(
      "BANDAR_RIVER_PRICING_URL",
      "https://console.river.ai/api/public/pricing",
    ),
  },
  nous: {
    baseUrl: baseUrl("BANDAR_NOUS_API", "https://inference-api.nousresearch.com/v1"),
    authUrl: authUrl("BANDAR_NOUS_PORTAL", "https://portal.nousresearch.com"),
  },
  hyper: {
    baseUrl: baseUrl("BANDAR_HYPER_API", "https://hyper.charm.land/v1"),
  },
  opencode: {
    baseUrl: baseUrl("BANDAR_OPENCODE_API", "https://opencode.ai/inference"),
  },
} satisfies Record<BuiltInProviderKind, EndpointSpecs>;

export const PROVIDER_MOUNTS: Record<BuiltInProviderKind, string> = {
  kilocode: "/api/openrouter",
  tokenharbor: "/v1",
  yeta: "/v1",
  river: "/v1",
  nous: "/v1",
  hyper: "/v1",
  opencode: "/inference",
};

export type ProviderEndpoint = {
  readonly baseUrl: string;
  readonly catalogUrl: string | null;
  readonly authUrl: string | null;
};

export type ProviderEndpoints = Record<BuiltInProviderKind, ProviderEndpoint>;

export const endpointSpecsFor = (kind: BuiltInProviderKind): EndpointSpecs =>
  PROVIDER_ENDPOINT_SPECS[kind];

/** The environment carries an origin, so the mount completes the base URL it stands for. */
export function withMount(kind: BuiltInProviderKind, origin: string): string {
  return `${origin.replace(/\/+$/u, "")}${PROVIDER_MOUNTS[kind]}`;
}

/** The OAuth origin behind a base URL: the mount stripped, or the URL's origin when absent. */
export function authUrlFor(baseUrl: string, mount: string): string {
  const base = baseUrl.replace(/\/+$/u, "");
  const suffix = mount.replace(/\/+$/u, "");

  return base.endsWith(suffix) ? base.slice(0, -suffix.length) : new URL(base).origin;
}

/** A kind whose login lives on its own base URL derives the origin from it. */
export function providerEndpoint(
  kind: BuiltInProviderKind,
  baseUrl: string,
  catalogUrl: string | null,
  authUrl: string | null,
): ProviderEndpoint {
  return {
    baseUrl,
    catalogUrl,
    authUrl: authUrl ?? (kind === "kilocode" ? authUrlFor(baseUrl, PROVIDER_MOUNTS[kind]) : null),
  };
}

const defaultEndpoint = (kind: BuiltInProviderKind): ProviderEndpoint => {
  const specs = endpointSpecsFor(kind);

  return providerEndpoint(
    kind,
    specs.baseUrl.default,
    specs.catalogUrl?.default ?? null,
    specs.authUrl?.default ?? null,
  );
};

export const DEFAULT_PROVIDER_ENDPOINTS: ProviderEndpoints = {
  kilocode: defaultEndpoint("kilocode"),
  tokenharbor: defaultEndpoint("tokenharbor"),
  yeta: defaultEndpoint("yeta"),
  river: defaultEndpoint("river"),
  nous: defaultEndpoint("nous"),
  hyper: defaultEndpoint("hyper"),
  opencode: defaultEndpoint("opencode"),
};
