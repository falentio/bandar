import * as v from "valibot";
import type {
  BuiltInProviderKind,
  Compat,
  GenericProviderKind,
  InputModality,
  ProviderAuthMode,
  ProviderKind,
} from "../../shared/providers";
import type {
  ConversationMessage,
  ToolCall,
  ToolCallDraft,
  ToolChoice,
  ToolDefinition,
  ToolParameters,
} from "../../shared/conversation";
import type { Credential, OAuthCredential } from "../credential";

/** A wire-neutral turn: one role and its parts, the same shape both ingresses produce. */
export type CanonicalMessage = ConversationMessage;

export type CanonicalRequest = {
  readonly messages: readonly CanonicalMessage[];
  /** Normalized definitions. Empty when the client declared no tools. */
  readonly tools: readonly ToolDefinition[];
  /** Null means "send nothing and let the wire's own default stand". */
  readonly toolChoice: ToolChoice | null;
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
  readonly toolCalls: readonly ToolCall[];
  readonly finishReason: string | null;
  readonly usage: CanonicalUsage;
};

export type CanonicalStreamEvent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool_call_start"; readonly call: ToolCallDraft }
  | { readonly type: "tool_call_delta"; readonly id: string; readonly arguments: string }
  | { readonly type: "usage"; readonly usage: CanonicalUsage }
  | { readonly type: "finish"; readonly reason: string | null };

/**
 * A wire that reports a plain stop for a turn that called tools still finishes as tool_calls.
 * A truncated or filtered turn passes through: a truncated call stayed truncated.
 */
export function finishOf(reason: string | null, toolCalls: readonly ToolCall[]): string | null {
  if (toolCalls.length === 0) return reason;

  if (reason === "length" || reason === "content_filter") return reason;

  return "tool_calls";
}

const JsonObjectSchema = v.record(v.string(), v.unknown());

/**
 * Canonical arguments are raw JSON text, so the three sites that need an object parse here and
 * say whose contract broke: what a client sent is its own bad request, what a model emitted is not.
 */
export function jsonObjectOf(
  call: ToolCall,
  kind: "invalid_request" | "protocol",
): ToolParameters {
  let parsed: unknown = null;

  try {
    parsed = JSON.parse(call.arguments);
  } catch {
    throw new UpstreamError(`tool call ${call.id} (${call.name}) has arguments that are not JSON`, kind);
  }

  const object = v.safeParse(JsonObjectSchema, parsed);

  if (!object.success || Array.isArray(parsed))
    throw new UpstreamError(
      `tool call ${call.id} (${call.name}) has arguments that are not a JSON object`,
      kind,
    );

  return object.output;
}

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
  | "not_found"
  | "unavailable"
  | "protocol"
  | "network"
  | "unknown";

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
  readonly label: string;
  readonly inputPricePerMtok: number | null;
  readonly cacheInputPricePerMtok: number | null;
  readonly outputPricePerMtok: number | null;
  readonly contextWindow?: number | null;
  readonly maxOutput?: number | null;
  readonly inputModalities?: readonly InputModality[] | null;
};

export type CatalogRequest = {
  readonly baseUrl: string;
  readonly catalogUrl: string | null;
  /** Read lazily so a public catalog never decrypts a saved credential. */
  readonly credential: () => Promise<Credential | null>;
  readonly signal: AbortSignal;
};

export type ProviderCatalog = (request: CatalogRequest) => Promise<readonly ModelCatalogEntry[]>;

export type DeviceLogin = {
  readonly code: string;
  readonly userCode: string;
  readonly verificationUrl: string;
  readonly expiresInSeconds: number;
  readonly intervalSeconds: number;
};

export type DevicePollResult =
  | { readonly state: "pending" }
  | { readonly state: "connected"; readonly credential: Credential };

export type ConnectorInput = {
  readonly signal: AbortSignal;
  readonly authUrl: string;
};

export interface OAuthConnector {
  start(input: ConnectorInput): Promise<DeviceLogin>;
  poll(code: string, input: ConnectorInput): Promise<DevicePollResult>;
}

export type CredentialRenewal = {
  readonly credential: OAuthCredential;
  readonly signal: AbortSignal;
  readonly authUrl: string;
};

/** Rotates an expiring OAuth credential before the request that needs it. */
export interface CredentialRenewer {
  due(credential: OAuthCredential, now: number): boolean;
  renew(input: CredentialRenewal): Promise<Credential>;
}

export type BuiltInProviderSettings = {
  readonly name: string;
  readonly slug: string;
};

export type WireRoute<K extends ProviderKind = ProviderKind> = {
  readonly adapter: ProviderAdapter<K>;
  /** Joined onto the provider base URL for this (kind, compat) pair. Absent: the base URL ends at the wire. */
  readonly mount?: string;
};

export type ProviderRoutes<K extends ProviderKind = ProviderKind> = Readonly<
  Partial<Record<Compat, WireRoute<K>>>
>;

export type CompatChoice =
  | { readonly compat: Compat }
  | { readonly compat: null; readonly reason: string };

export type DefinitionCapabilities<K extends ProviderKind> = {
  readonly routes: ProviderRoutes<K>;
  readonly defaultCompat: (upstreamModel: string) => CompatChoice;
  readonly authModes: readonly ProviderAuthMode[];
  readonly oauth?: OAuthConnector;
  readonly catalog?: ProviderCatalog;
  readonly renew?: CredentialRenewer;
};

export function always(compat: Compat): (upstreamModel: string) => CompatChoice {
  return () => ({ compat });
}

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
