# Provider adapters

The gateway speaks one canonical, text-only chat shape. An adapter owns
everything between that shape and one upstream wire: URLs, headers, request
translation, response parsing, SSE event parsing, usage extraction, and finish
reason normalization.

Every adapter is synchronous to the registry but asynchronous to the network:

```ts
export interface ProviderAdapter {
  readonly kind: ProviderKind;
  chat(input: AdapterInput): Promise<CanonicalResult>;
  stream(input: AdapterInput): AsyncGenerator<CanonicalStreamEvent, void, void>;
}

export type AdapterInput = {
  readonly target: ProviderTarget;
  readonly request: CanonicalRequest;
  readonly signal: AbortSignal;
};

export type ProviderTarget = {
  readonly providerId: string;
  readonly kind: ProviderKind;
  readonly baseUrl: string;
  readonly credential: Credential;
  readonly upstreamModel: string;
};
```

`Credential` is a sealed-bundle union from `src/server/credential.ts`:

```ts
| { authMode: "api-key"; apiKey: string }
| { authMode: "oauth"; accessToken: string; organizationId: string | null }
```

API-key adapters read `apiKey`. An OAuth kind reads `accessToken` and any
provider-specific account field. Kilo Code sends the token as a bearer and adds
`X-Kilocode-OrganizationID` when the account profile named an organization.

`CanonicalRequest` carries `messages` (`system | user | assistant`), `temperature`,
`topP`, `maxTokens`, and `stop`. `CanonicalResult` carries `text`, `finishReason`,
and `usage` (`inputTokens`, `outputTokens`, each `number | null`).
`CanonicalStreamEvent` is one of:

```ts
| { type: "text"; text: string }
| { type: "usage"; usage: CanonicalUsage }
| { type: "finish"; reason: string | null }
```

The gateway does not read provider JSON. It sees text, usage, finish, or a thrown
`UpstreamError`. That boundary is the extension point: a new wire format changes
one provider directory.

## Registry

Each provider is a directory under `src/server/providers/<kind>/`. Its
`index.ts` exports one definition object that bundles the adapter with every
capability the provider has. `src/server/providers/registry.ts` holds the record:

```ts
const genericDefinitions = {
  openai,
  anthropic,
  google,
} satisfies GenericProviderDefinitions;

const builtInDefinitions = {
  kilocode,
} satisfies BuiltInProviderDefinitions;

const providerDefinitions: ProviderDefinitionRecord = {
  ...genericDefinitions,
  ...builtInDefinitions,
};

export function definitionFor<K extends ProviderKind>(kind: K): ProviderDefinitionRecord[K] {
  return providerDefinitions[kind];
}
```

`src/server/providers/types.ts` splits a definition in two. A generic wire has
capabilities only. A built-in also carries the settings its row is seeded with:

```ts
type ProviderCapabilities = {
  readonly adapter: ProviderAdapter;
  readonly oauth?: OAuthConnector;
  readonly catalog?: ProviderCatalog;
};

export type GenericProviderDefinition<K extends GenericProviderKind = GenericProviderKind> =
  ProviderCapabilities & {
    readonly kind: K;
    readonly builtIn?: undefined;
  };

export type BuiltInProviderDefinition<K extends BuiltInProviderKind = BuiltInProviderKind> =
  ProviderCapabilities & {
    readonly kind: K;
    readonly builtIn: BuiltInProviderSettings;
  };
```

`GenericProviderDefinitions` and `BuiltInProviderDefinitions` make the compiler
fail when a kind list gains a member without a definition, when an entry carries
a `kind` that disagrees with its key, and when a built-in has no `builtIn`
settings. The key check works because each definition is annotated with its own
kind, as in `GenericProviderDefinition<"openai">` or
`BuiltInProviderDefinition<"kilocode">`. `builtInProviders` derives the seeding
list from `BUILT_IN_PROVIDER_KINDS`, so seeding order does not depend on the
record's key order.

There is no dynamic loading: the binary is compiled, so a static, exhaustive
record is the registration mechanism.

## Built-in and custom providers

`GENERIC_PROVIDER_KINDS` is the list a user sees in **Add custom provider**:
`openai`, `anthropic`, and `google`. A custom provider is a row in SQLite with
`origin = "custom"` and one of those wires. Adding one never changes code.

A built-in provider takes its name, slug, and default base URL from
`BUILT_IN_PROVIDERS` and its kind from `BUILT_IN_PROVIDER_KINDS` in
`src/shared/providers.ts`. Its behavior comes from the definition in
`src/server/providers/<kind>/`. Its row has `origin = "builtin"` and is seeded
for every account by `ensureBuiltInProviders`. Kilo Code is the current
built-in: `src/server/providers/kilocode/index.ts` bundles its adapter, its
`OAuthConnector`, its catalog reader, and an env-aware `builtIn.baseUrl()`. The
definition reads that function at seeding time, so `BANDAR_KILOCODE_API` can
point the seeded row at another origin. Built-in rows cannot be created through
the provider API, edited in Settings, or removed; they reappear on the next
listing if deleted directly.

The distinction is about existence, not wire shape. A built-in may speak an
OpenAI-compatible wire, as Kilo Code does, but it still gets its own adapter so
its OAuth headers, catalog, and account header stay in one place.

## Errors

Adapters throw one type:

```ts
new UpstreamError(message, kind, status);
```

`kind` is one of `auth`, `rate_limit`, `invalid_request`, `unavailable`,
`protocol`, or `network`. `status` is the upstream HTTP status when there was
one. The gateway maps `rate_limit` to 429, `invalid_request` to 400, and the rest
to 502, then records the event with the error kind.

Helpers in `adapters/http.ts`:

- `joinUrl(baseUrl, "/path")` strips duplicate slashes.
- `postJson({ url, headers, body, signal })` turns a network failure into
  `UpstreamError(..., "network")` and passes an abort through.
- `requireOk(response)` reads an error envelope (`error.message`, `message`, or
  plain text) and classifies the status.
- `sseData(body, signal)` yields the joined `data:` lines of each SSE event.
- `apiKeyHeader(name, key)` omits the header when the upstream needs no key.

## Wire mapping

|                | OpenAI                                            | Anthropic                                                    | Google GenAI                             | Kilo Code                                         |
| -------------- | ------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------- | ------------------------------------------------- |
| Chat URL       | `{base}/chat/completions`                         | `{base}/messages`                                            | `{base}/models/{model}:generateContent`  | `{base}/chat/completions`                         |
| Stream URL     | same                                              | same                                                         | `...:streamGenerateContent?alt=sse`      | same                                              |
| Auth header    | `Authorization: Bearer`                           | `x-api-key` + `anthropic-version: 2023-06-01`                | `x-goog-api-key`                         | `Authorization: Bearer` + optional org header     |
| System prompt  | a `system` message                                | top-level `system`                                           | `systemInstruction`                      | a `system` message                                |
| Assistant role | `assistant`                                       | `assistant`                                                  | `model`                                  | `assistant`                                       |
| Max tokens     | `max_tokens`                                      | required `max_tokens` (default 1024)                         | `generationConfig.maxOutputTokens`       | `max_tokens`                                      |
| Stop           | `stop`                                            | `stop_sequences`                                             | `generationConfig.stopSequences`         | `stop`                                            |
| Stream usage   | final chunk, after `stream_options.include_usage` | `message_start` + `message_delta`                            | `usageMetadata` on chunks                | final chunk, after `stream_options.include_usage` |
| Finish reason  | native                                            | `end_turn`/`stop_sequence` → `stop`, `max_tokens` → `length` | `STOP` → `stop`, `MAX_TOKENS` → `length` | native                                            |

Anthropic and Google reject adjacent messages with the same role in some
configurations, so both adapters merge consecutive same-role messages. OpenAI
and Kilo Code share the OpenAI chat shape, so both are passed through unchanged
apart from optional fields the canonical request does not carry.

Kilo Code has two URLs: the OpenRouter-shaped gateway at
`https://api.kilo.ai/api/openrouter` for chat, and the catalog at
`https://api.kilo.ai/api/gateway/models`. `src/server/providers/kilocode/adapter.ts`
owns only the former. `catalog.ts` in the same directory reads the catalog for
**Import catalog** and turns per-token pricing into per-million-token prices. A
`-1` price means Kilo routes the model dynamically and is stored as `null`.

## Streaming rules

1. `stream()` yields text events only for non-empty deltas.
2. Yield `usage` as soon as the provider reports it. The gateway keeps the last
   value it saw and writes one usage chunk at the end.
3. Yield exactly one `finish` before returning, even when the provider omitted a
   reason; use `null`.
4. A provider error frame throws `UpstreamError`. The gateway sends an SSE error
   object and `[DONE]`, records the failure, and closes.
5. Respect `input.signal`. The gateway aborts it when the client disconnects, and
   records the attempt as `aborted`.

TTFT is measured by the gateway at the first non-empty text event. Adapters do
not measure time, and non-streaming requests have no TTFT.

## Adding a kind

1. For a generic wire, add the literal to `GENERIC_PROVIDER_KINDS` in
   `src/shared/providers.ts`. For a built-in, add it to
   `BUILT_IN_PROVIDER_KINDS` and add its name, slug, and base URL to
   `BUILT_IN_PROVIDERS`.
2. Create `src/server/providers/<kind>/adapter.ts`. Import the helpers from
   `src/server/providers/http.ts`, implement `chat` and `stream`, and keep every
   wire type inside the file.
3. Create `src/server/providers/<kind>/index.ts` with the definition, annotated
   with its own kind. Add an `OAuthConnector` or a `ProviderCatalog` when the
   provider has one.
4. Register the definition in `genericDefinitions` or `builtInDefinitions` in
   `src/server/providers/registry.ts`. Both `satisfies` records report a missing
   entry, a wrong kind for the key, and a built-in without its `builtIn`
   settings.
5. Add a branch to the fake upstream in `scripts/smoke.ts` and two checks: one
   non-streaming text/usage assertion and one SSE text/usage/finish assertion.
   The fake upstream verifies the adapter's auth header too.
6. Run `bun run check && bun run test && bun run build && bun run smoke`.

No database migration is needed for a new kind: `providers.kind` is text and its
TypeScript type comes from `ProviderKind`. Credentials already have an
`auth_mode` column and a sealed bundle, so an API-key kind and an OAuth kind use
the same row shape. `origin` separates a seeded built-in from a custom row. The
dashboard's kind picker, the add dialog, and the provider logo table read the
generic and built-in lists, so a new kind appears once it has a path in
`./src/client/components/provider-logo.tsx`.

## OAuth built-ins

Kilo Code is the first provider that logs in instead of accepting a key. A
definition with an `oauth` connector serves the
`/api/providers/:id/oauth/{start,poll}` routes; without one, both routes answer 400. The dashboard shows the **Connection** tab for Kilo Code by kind, so a new
OAuth kind also needs a branch in `src/client/components/provider-page.tsx`.

The connector contract lives in `src/server/providers/types.ts`:

```ts
export interface OAuthConnector {
  start(signal: AbortSignal): Promise<DeviceLogin>;
  poll(code: string, signal: AbortSignal): Promise<DevicePollResult>;
}
```

`src/server/providers/kilocode/oauth.ts` implements it. The API keeps the device
code server-side, keyed by user and provider; the start response returns only
the short user code and the verification URL. The poll stores the token with
`saveOAuthCredential`, which seals the OAuth bundle and sets
`providers.auth_mode = "oauth"`. An API key saved later replaces the connection
and switches the mode back to `"api-key"`. A built-in provider's row is seeded
before login, so the Connection tab works on the first visit.

An OAuth connector that needs an account identifier should look it up during
`poll` and return it in the bundle, as Kilo Code does with `organizationId`. The
adapter then decides whether that identifier becomes a header.

## Contract tests

The smoke run is the adapter conformance suite. It boots the compiled binary,
points one custom provider of each generic wire at a local fake upstream, checks
that the built-in Kilo Code row was seeded, drives the gateway with a gateway key,
and reads the analytics row back. That covers key decryption, header construction,
request translation, non-stream parsing, SSE parsing, usage extraction, finish
normalization, TTFT, and tokens-per-second. The Kilo Code checks go through a fake
device-auth server, store the OAuth bundle, import a catalog that collides with an
existing alias, call both stream and non-stream gateway routes with the
organization header, and prove the built-in row cannot be added, edited, removed,
or seeded twice.

Adapters whose wire differs in a way the fake does not model (for example, a
provider that sends usage only on a final event) should extend the fake and add
a focused check rather than mock the adapter in a unit test.
