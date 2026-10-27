import type { BuiltInProviderKind, GenericProviderKind } from "../../shared/providers";
import type { Credential } from "../credential";
import type { ProviderAdapter } from "../router/types";

export type ModelCatalogEntry = {
  readonly upstreamModel: string;
  readonly alias: string;
  readonly inputPricePerMtok: number | null;
  readonly outputPricePerMtok: number | null;
};

export type ProviderCatalog = (signal: AbortSignal) => Promise<readonly ModelCatalogEntry[]>;

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

type ProviderCapabilities = {
  readonly adapter: ProviderAdapter;
  readonly oauth?: OAuthConnector;
  readonly catalog?: ProviderCatalog;
};

export type GenericProviderDefinition = ProviderCapabilities & {
  readonly kind: GenericProviderKind;
  readonly builtIn?: undefined;
};

export type BuiltInProviderDefinition = ProviderCapabilities & {
  readonly kind: BuiltInProviderKind;
  readonly builtIn: BuiltInProviderSettings;
};

export type ProviderDefinition = GenericProviderDefinition | BuiltInProviderDefinition;
