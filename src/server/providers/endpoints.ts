import {
  BUILT_IN_PROVIDER_KINDS,
  BUILT_IN_PROVIDERS,
  type BuiltInProviderKind,
  type ProviderKind,
} from "../../shared/providers";

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

const baseUrl = (kind: BuiltInProviderKind, env: string): EndpointSpec => {
  const value = BUILT_IN_PROVIDERS[kind].baseUrl;

  return {
    env,
    default: value,
    description: `The full API base URL, including the mount. Defaults to ${value}.`,
  };
};

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
    baseUrl: baseUrl("kilocode", "BANDAR_KILOCODE_API"),
    catalogUrl: catalogUrl("BANDAR_KILOCODE_MODELS_URL", "https://api.kilo.ai/api/gateway/models"),
  },
  tokenharbor: {
    baseUrl: baseUrl("tokenharbor", "BANDAR_TOKENHARBOR_API"),
  },
  yeta: {
    baseUrl: baseUrl("yeta", "BANDAR_YETA_API"),
  },
  river: {
    baseUrl: baseUrl("river", "BANDAR_RIVER_API"),
    catalogUrl: catalogUrl(
      "BANDAR_RIVER_PRICING_URL",
      "https://console.river.ai/api/public/pricing",
    ),
  },
  nous: {
    baseUrl: baseUrl("nous", "BANDAR_NOUS_API"),
    authUrl: authUrl("BANDAR_NOUS_PORTAL", "https://portal.nousresearch.com"),
  },
  hyper: {
    baseUrl: baseUrl("hyper", "BANDAR_HYPER_API"),
  },
  opencode: {
    baseUrl: baseUrl("opencode", "BANDAR_OPENCODE_API"),
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

export const isBuiltInProviderKind = (kind: ProviderKind): kind is BuiltInProviderKind =>
  BUILT_IN_PROVIDER_KINDS.some((builtIn) => builtIn === kind);

/** The endpoint of a provider row: generic kinds have none. */
export const endpointFor = (
  endpoints: ProviderEndpoints,
  kind: ProviderKind,
): ProviderEndpoint | null => (isBuiltInProviderKind(kind) ? endpoints[kind] : null);

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
