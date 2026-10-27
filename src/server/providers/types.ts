import type {
  BuiltInProviderKind,
  GenericProviderKind,
  ProviderAuthMode,
  ProviderKind,
} from "../../shared/providers";
import type { Credential } from "../credential";

export type CanonicalMessage = {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
};

export type CanonicalRequest = {
  readonly messages: readonly CanonicalMessage[];
  readonly temperature?: number;
  readonly topP?: number;
  readonly maxTokens?: number;
  readonly stop?: readonly string[];
};

export type CanonicalUsage = {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
};

export type CanonicalResult = {
  readonly text: string;
  readonly finishReason: string | null;
  readonly usage: CanonicalUsage;
};

export type CanonicalStreamEvent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "usage"; readonly usage: CanonicalUsage }
  | { readonly type: "finish"; readonly reason: string | null };

export type ProviderTarget = {
  readonly providerId: string;
  readonly kind: ProviderKind;
  readonly baseUrl: string;
  readonly credential: Credential;
  readonly upstreamModel: string;
};

export type AdapterInput = {
  readonly target: ProviderTarget;
  readonly request: CanonicalRequest;
  readonly signal: AbortSignal;
};

export interface ProviderAdapter<K extends ProviderKind = ProviderKind> {
  readonly kind: K;
  chat(input: AdapterInput): Promise<CanonicalResult>;
  stream(input: AdapterInput): AsyncGenerator<CanonicalStreamEvent, void, void>;
}

export type UpstreamErrorKind =
  | "auth"
  | "rate_limit"
  | "invalid_request"
  | "unavailable"
  | "protocol"
  | "network";

export class UpstreamError extends Error {
  readonly kind: UpstreamErrorKind;
  readonly status: number | null;

  constructor(message: string, kind: UpstreamErrorKind, status: number | null = null) {
    super(message);
    this.name = "UpstreamError";
    this.kind = kind;
    this.status = status;
  }
}

export type ModelCatalogEntry = {
  readonly upstreamModel: string;
  readonly alias: string;
  readonly inputPricePerMtok: number | null;
  readonly outputPricePerMtok: number | null;
};

export type CatalogRequest = {
  readonly baseUrl: string;
  readonly credential: Credential | null;
  readonly signal: AbortSignal;
};

export type ProviderCatalog = (request: CatalogRequest) => Promise<readonly ModelCatalogEntry[]>;

export type DeviceLogin = {
  readonly code: string;
  readonly userCode: string;
  readonly verificationUrl: string;
  readonly expiresInSeconds: number;
};

export type DevicePollResult =
  | { readonly state: "pending" }
  | { readonly state: "connected"; readonly credential: Credential };

export interface OAuthConnector {
  start(signal: AbortSignal): Promise<DeviceLogin>;
  poll(code: string, signal: AbortSignal): Promise<DevicePollResult>;
}

export type BuiltInProviderSettings = {
  readonly name: string;
  readonly slug: string;
  readonly baseUrl: () => string;
};

export type DefinitionCapabilities<K extends ProviderKind> = {
  readonly adapter: ProviderAdapter<K>;
  readonly authModes: readonly ProviderAuthMode[];
  readonly oauth?: OAuthConnector;
  readonly catalog?: ProviderCatalog;
};

export type GenericProviderDefinition<K extends GenericProviderKind = GenericProviderKind> =
  DefinitionCapabilities<K> & {
    readonly kind: K;
    readonly builtIn?: undefined;
  };

export type BuiltInProviderDefinition<K extends BuiltInProviderKind = BuiltInProviderKind> =
  DefinitionCapabilities<K> & {
    readonly kind: K;
    readonly builtIn: BuiltInProviderSettings;
  };

export type ProviderDefinition = GenericProviderDefinition | BuiltInProviderDefinition;

export type GenericProviderDefinitions = {
  readonly [K in GenericProviderKind]: GenericProviderDefinition<K>;
};

export type BuiltInProviderDefinitions = {
  readonly [K in BuiltInProviderKind]: BuiltInProviderDefinition<K>;
};

export type ProviderDefinitionRecord = GenericProviderDefinitions & BuiltInProviderDefinitions;
