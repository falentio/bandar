import type { ProviderKind } from "../../shared/providers";

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
  readonly apiKey: string;
  readonly upstreamModel: string;
};

export type AdapterInput = {
  readonly target: ProviderTarget;
  readonly request: CanonicalRequest;
  readonly signal: AbortSignal;
};

export interface ProviderAdapter {
  readonly kind: ProviderKind;
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
