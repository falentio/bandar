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
one file.

## Registry

`src/server/router/adapters/index.ts`:

```ts
const adapters = {
  openai,
  anthropic,
  google,
  kilocode,
} satisfies Record<ProviderKind, ProviderAdapter>;

export function adapterFor(kind: ProviderKind): ProviderAdapter {
  return adapters[kind];
}
```

`satisfies Record<ProviderKind, ProviderAdapter>` makes the compiler fail when
`PROVIDER_KINDS` gains a member without an adapter. There is no dynamic loading:
the binary is compiled, so a static, exhaustive record is the registration
mechanism.

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
`https://api.kilo.ai/api/gateway/models`. The adapter owns only the former; the
provider repo reads the catalog for **Import catalog** and turns per-token
pricing into per-million-token prices. A `-1` price means Kilo routes the model
dynamically and is stored as `null`.

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

1. Add the literal to `PROVIDER_KINDS` in `src/shared/providers.ts`.
2. Create `src/server/router/adapters/<kind>.ts`. Import the helpers, implement
   `chat` and `stream`, and keep every wire type inside the file.
3. Register it in `src/server/router/adapters/index.ts`. The `satisfies` record
   reports a missing entry.
4. Add a branch to the fake upstream in `scripts/smoke.ts` and two checks: one
   non-streaming text/usage assertion and one SSE text/usage/finish assertion.
   The fake upstream verifies the adapter's auth header too.
5. Run `bun run check && bun run test && bun run build && bun run smoke`.

No database migration is needed for a new kind: `providers.kind` is text and its
TypeScript type comes from `ProviderKind`. Credentials already have an
`auth_mode` column and a sealed bundle, so an API-key kind and an OAuth kind use
the same row shape. The dashboard's kind picker and the provider logo table read
`PROVIDER_KINDS`, so a new kind appears in both once it has a path in
`./src/client/components/provider-logo.tsx`.

## OAuth kinds

Kilo Code is the first kind that logs in instead of accepting a key. The shared
contract adds it to `OAUTH_PROVIDER_KINDS`; a kind in that list gets the
**Connection** tab and the `/api/providers/:id/oauth/{start,poll}` routes.

`src/server/oauth.ts` holds one `OAuthConnector` per OAuth kind:

```ts
export interface OAuthConnector {
  start(signal: AbortSignal): Promise<DeviceLogin>;
  poll(code: string, signal: AbortSignal): Promise<DevicePollResult>;
}
```

The registry is a `satisfies Record<OAuthProviderKind, OAuthConnector>`, so a new
OAuth kind fails the type check until it has a connector. The API keeps the
device code server-side, keyed by user and provider; the start response returns
only the short user code and the verification URL. The poll stores the token
with `saveOAuthCredential`, which seals the OAuth bundle and sets
`providers.auth_mode = "oauth"`. An API key saved later replaces the connection
and switches the mode back to `"api-key"`.

An OAuth connector that needs an account identifier should look it up during
`poll` and return it in the bundle, as Kilo Code does with `organizationId`. The
adapter then decides whether that identifier becomes a header.

## Contract tests

The smoke run is the adapter conformance suite. It boots the compiled binary,
points one provider of each kind at a local fake upstream, drives the gateway with
a gateway key, and reads the analytics row back. That covers key decryption,
header construction, request translation, non-stream parsing, SSE parsing,
usage extraction, finish normalization, TTFT, and tokens-per-second. The Kilo
Code checks go through a fake device-auth server, store the OAuth bundle, import
a catalog that collides with an existing alias, and call both stream and
non-stream gateway routes with the organization header.

Adapters whose wire differs in a way the fake does not model (for example, a
provider that sends usage only on a final event) should extend the fake and add
a focused check rather than mock the adapter in a unit test.
