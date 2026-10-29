# Provider adapters

The gateway speaks one canonical, text-only chat shape. An adapter owns
everything between that shape and one upstream wire: URLs, headers, request
translation, response parsing, SSE event parsing, usage extraction, and finish
reason normalization.

Every adapter is synchronous to the registry but asynchronous to the network:

```ts
export interface ProviderAdapter<K extends ProviderKind = ProviderKind> {
  readonly kind: K;
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

One implementation serves every OpenAI-compatible kind:
`src/server/providers/openai/compatible.ts` exposes `bearerAdapter(kind, label?)`
and `chatAdapter({ kind, label, headers })`, both returning `ProviderAdapter<K>`.
`headers` is a `HeaderFactory` from `src/server/providers/http.ts`, and
`bearerAdapter` is its plain-bearer form. Kilo Code uses `chatAdapter` for its
organization header and its own auth error; Token Harbor, Yeta, River, Nous Portal,
Hyper, and the OpenCode Go chat wire reach it through `bearerAdapter`.

`src/server/providers/openai/responses.ts` is a fourth options factory with that
shape: `responsesAdapter({ kind, label, headers })` speaks the OpenAI Responses
wire and maps it into the same canonical types. It is a separate wire rather than
a mode of `chatAdapter`, so a kind can declare both and a gateway can mount each
where it likes.

The Messages and GenAI adapters are options factories with the same shape:
`anthropicAdapter({ kind, label, headers })` and
`googleAdapter({ kind, label, headers })`. Their native instances pass
`apiKeyHeaders("x-api-key")` and `apiKeyHeaders("x-goog-api-key")`; a gateway
passes `bearerHeaders` instead. `anthropic-version` stays inside the Messages
wire, because it belongs to the protocol and not to the credential.

`credential` is the attempt's credential. The gateway opens it immediately before
the call and never passes more than one to an adapter. An OAuth credential that
is due arrives already renewed.

`Credential` is a sealed-bundle union from `src/server/credential.ts`:

```ts
| { authMode: "api-key"; apiKey: string }
| {
    authMode: "oauth";
    accessToken: string;
    organizationId: string | null;
    refreshToken: string | null;
    expiresAt: number | null;
  }
```

API-key adapters read `apiKey`. An OAuth kind reads `accessToken` and any
provider-specific account field. Kilo Code sends the token as a bearer and adds
`X-Kilocode-OrganizationID` when the account profile named an organization.
`refreshToken` and `expiresAt` are null on a Kilo Code login, which never
renews; the Nous Portal login fills both. A bundle sealed before those fields
existed parses with both null, so an old row keeps working
(`src/server/credential.test.ts`).

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
one adapter file and the routes that name it.

## Ingress

Two ingress wires reach the canonical shape. `POST /v1/chat/completions` speaks
the OpenAI chat shape and `POST /v1/messages` speaks the Anthropic Messages
shape. Both run `runChat`, so model references, tags with failover, credential
order, cooldowns, and analytics behave the same on either route. A wire owns its
error envelope, its completed response, and its stream frames:
`src/server/router/wire.ts` holds `openAiWire` and
`src/server/router/anthropic-wire.ts` holds `anthropicWire`. Both satisfy
`ChatWire` and a caller passes one as `ChatInput.wire`; the default is
`openAiWire`.

### Anthropic Messages ingress

`POST /v1/messages` accepts these fields:

| Field                                                  | Meaning                                                                       |
| ------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `model`                                                | An address, `tags/<slug>`, or `<provider>/<model>`, resolved by `resolvePlan` |
| `messages`                                             | `user` and `assistant` turns; content is a string or an array of text blocks  |
| `system`                                               | A string or an array of text blocks; becomes the leading system message       |
| `stream`                                               | `true` answers SSE, `false` or absent answers one message                     |
| `max_tokens`, `temperature`, `top_p`, `stop_sequences` | Passed through as `maxTokens`, `temperature`, `topP`, `stop`                  |

Every other field is ignored, including `metadata`, `thinking`, `top_k`,
`tools`, and `tool_choice`. Multiple text blocks in one message join with a
newline, and multiple `system` blocks join the same way.

bandar is a text gateway, so a block whose type is not `text` is a rejection,
never a silent drop. A `tool_use`, `tool_result`, `image`, or `document`
block anywhere in `messages` or `system` answers 422 and names the block type
and its position:

```text
messages[1].content[0]: tool_use blocks are not supported by this text gateway
```

Because `tools` is ignored, a client such as Claude Code connects and receives
text only. It gets no tool calls back.

A completed answer is an Anthropic message object: `type: "message"`,
`role: "assistant"`, one `text` block, `stop_reason`, and
`usage: {input_tokens, output_tokens}`. `stop_reason` maps from the canonical
reason: `stop` becomes `end_turn`, `length` becomes `max_tokens`,
`tool_calls` becomes `tool_use`, and `content_filter` becomes `refusal`.

A streaming answer is SSE, and every frame has an `event:` line and a `data:`
line. The order is fixed:

```text
message_start
content_block_start
content_block_delta   (one per text delta)
content_block_stop
message_delta         (stop_reason and usage)
message_stop
```

The canonical stream reports usage when the upstream finishes, so
`message_start` carries `input_tokens: 0` and `message_delta` carries the
final `input_tokens` and `output_tokens`. An Anthropic client that reads usage
from `message_delta` sees the real numbers.

An upstream failure answers the Anthropic error envelope with the status bandar
uses for that kind:
`{"type":"error","error":{"type":"authentication_error","message":"..."}}`.
The status is 400 for an invalid request, 404 for a missing model or route, 429
for a rate limit, and 502 for an auth, network, protocol, or unavailable
failure. A missing or unknown gateway key is 401 with
`type: "authentication_error"`. A stream that fails after its first frame sends
one `event: error` frame with the same envelope and then closes, because the
status line is already sent.

### Token count

`POST /v1/messages/count_tokens` returns `{"input_tokens": n}`. It does not
call the upstream. `n` is `ceil(total characters / CHARS_PER_TOKEN)`, with
`CHARS_PER_TOKEN = 4` exported from `src/server/router/anthropic-wire.ts`. The
count covers `system` and every message joined with a newline. It is a
character estimate for client budgeting, not a tokenizer, and it can differ from
the provider count.

## Registry

Each provider is a directory under `src/server/providers/<kind>/`. Its
`index.ts` exports one definition object that bundles the kind's wires with every
capability the provider has. `src/server/providers/registry.ts` holds the record:

```ts
const genericDefinitions = {
  openai,
  anthropic,
  google,
} satisfies GenericProviderDefinitions;

const builtInDefinitions = {
  kilocode,
  tokenharbor,
  yeta,
  river,
  nous,
  hyper,
  opencode,
  zro,
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
type DefinitionCapabilities<K extends ProviderKind> = {
  readonly routes: ProviderRoutes<K>;
  readonly defaultCompat: (upstreamModel: string) => CompatChoice;
  readonly authModes: readonly ProviderAuthMode[];
  readonly oauth?: OAuthConnector;
  readonly catalog?: ProviderCatalog;
  readonly renew?: CredentialRenewer;
};

type WireRoute<K extends ProviderKind = ProviderKind> = {
  readonly adapter: ProviderAdapter<K>;
  /** Joined onto the provider base URL for this (kind, compat) pair. */
  readonly mount?: string;
};

type ProviderRoutes<K extends ProviderKind = ProviderKind> = Readonly<
  Partial<Record<Compat, WireRoute<K>>>
>;

type CompatChoice =
  | { readonly compat: Compat }
  | { readonly compat: null; readonly reason: string };

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
```

`Compat` is `chat | responses | messages | genai`, declared in
`src/shared/providers.ts` and orthogonal to the provider kind: `chat` is OpenAI
chat completions, `responses` is OpenAI Responses, `messages` is Anthropic
Messages, and `genai` is Google GenAI. A kind declares one route per wire it can
speak, and a route without a `mount` has its wire at the end of the base URL.
`compatsOf(kind)` answers the declared list in the shared order, and it is the
only list of a kind's compatibilities.

`defaultCompat` is the provider's own rule for one upstream model, and it is
total: a model the provider cannot route comes back as a `null` compat with the
reason, not as a missing entry. A kind whose wire never depends on the model
writes `always("chat")` and its definition stays one line longer than before.
`registry.test.ts` fails when a declared route's adapter belongs to another kind,
when a mount is not an absolute path without a trailing slash, when a default
names a route the kind does not declare, and when a `Compat` value is declared by
no kind at all.

`authModes` is the credential modes the kind can accept, and it is the only source
for them: a custom kind declares `["api-key"]`, Kilo Code declares
`["api-key", "oauth"]` because a device login and a pasted key both reach the
same bearer header, and Nous Portal declares only `["oauth"]` because the portal
issues no key. The `Provider` value on the wire carries the same list, which is
what turns into the credential dialog's tabs, and the credential routes reject an
API key for a kind that does not list `api-key` (`unsupported_mode`, HTTP 400).
`registry.test.ts` requires a kind that lists `oauth` to have a connector, so the
two cannot drift apart.

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
for every account by `ensureBuiltInProviders`. There are eight: Kilo Code,
Token Harbor, Yeta, River, Nous Portal, Hyper, OpenCode Go, and Zro. Each `index.ts`
bundles its adapter with whatever else the provider has: a catalog for all eight,
an `OAuthConnector` for Kilo Code and Nous Portal, and a `CredentialRenewer` for
Nous Portal. The endpoints are not part of the definition: seeding reads the
resolved config's `baseUrl` for the kind and updates the row in place when it
changed. The gateway reads the resolved endpoint directly, so an edit reaches it
on the next request, and the seeded row catches up on the next listing. Built-in rows
cannot be created through the provider API, edited in Settings, or removed; they
reappear on the next listing if deleted directly.

Seeding is idempotent per kind. If a custom row already owns a slug that has
since become reserved, the built-in takes the next free slug from
`availableSlug` instead of being silently suppressed, and its name falls back the
same way. That fallback is assigned once: deleting the custom row does not
restore the reserved slug. Built-ins appear in `BUILT_IN_PROVIDER_KINDS` order,
even when one is seeded later than the rest.

The distinction is about existence, not wire shape. Token Harbor, Yeta, River,
Nous Portal, and Hyper build the shared OpenAI adapter, and their `index.ts` adds
only the catalog, the login, or the renewal that is theirs. Kilo Code needs its
own adapter headers, and OpenCode Go is the one built-in that serves four wires.
Zro speaks chat on the shared OpenAI adapter and messages on the Anthropic one,
both at its one base URL and both under a bearer key, so neither route needs a
mount and `defaultCompat` sends every model to chat.

## Endpoints

`src/server/providers/endpoints.ts` is the one table of provider host names. Each
built-in kind declares the fields it uses, and each field carries the environment
variable that used to feed it, the built-in default, and the help text the
generated schema shows:

| kind          | field        | environment variable         | mount appended    |
| ------------- | ------------ | ---------------------------- | ----------------- |
| `kilocode`    | `baseUrl`    | `BANDAR_KILOCODE_API`        | `/api/openrouter` |
| `kilocode`    | `catalogUrl` | `BANDAR_KILOCODE_MODELS_URL` | none              |
| `tokenharbor` | `baseUrl`    | `BANDAR_TOKENHARBOR_API`     | `/v1`             |
| `yeta`        | `baseUrl`    | `BANDAR_YETA_API`            | `/v1`             |
| `river`       | `baseUrl`    | `BANDAR_RIVER_API`           | `/v1`             |
| `river`       | `catalogUrl` | `BANDAR_RIVER_PRICING_URL`   | none              |
| `nous`        | `baseUrl`    | `BANDAR_NOUS_API`            | `/v1`             |
| `nous`        | `authUrl`    | `BANDAR_NOUS_PORTAL`         | none              |
| `hyper`       | `baseUrl`    | `BANDAR_HYPER_API`           | `/v1`             |
| `opencode`    | `baseUrl`    | `BANDAR_OPENCODE_API`        | `/inference`      |
| `zro`         | `baseUrl`    | `BANDAR_ZRO_API`             | `/v1`             |

The config resolver reads `config.json` first, then the variable, then the
default. A file value is the full URL and is used as written. A variable is an
origin, so the mount completes it: `BANDAR_HYPER_API=http://127.0.0.1:9000/hyper`
resolves to `http://127.0.0.1:9000/hyper/v1`. `ProviderDeps.endpoints` carries
the result as a record of `{ baseUrl, catalogUrl, authUrl }`, with `null` for a
field the kind does not have. `endpointFor` returns the record for a built-in kind
and `null` for a generic one.

Kilocode's `authUrl` is derived from its resolved base URL, because its login and
its inference API share a host: the `/api/openrouter` suffix is stripped, and a
base URL without that suffix uses its own origin.

```ts
export type ProviderEndpoint = {
  readonly baseUrl: string;
  readonly catalogUrl: string | null;
  readonly authUrl: string | null;
};

export type ProviderEndpoints = Record<BuiltInProviderKind, ProviderEndpoint>;
```

## Catalogs

`ProviderCatalog` receives the base URL, the catalog URL, an abort signal, and the
credential the chain would try first:

```ts
export type CatalogRequest = {
  readonly baseUrl: string;
  readonly catalogUrl: string | null;
  readonly credential: () => Promise<Credential | null>;
  readonly signal: AbortSignal;
};

export type ProviderCatalog = (request: CatalogRequest) => Promise<readonly ModelCatalogEntry[]>;
```

A kind with a catalog but no separate document ignores `catalogUrl` and reads
`{baseUrl}/models`. Kilo Code and River read the document when it is set and fall
back to their built-in URL when the config leaves it out.

The refresh route passes a function that calls `readFirstCredential`, so a keyed
import uses the same key the first chat attempt would. A public catalog never
calls it, so it never decrypts a saved credential. `readModelIds` in
`src/server/providers/catalog.ts` is the common keyed catalog: `GET {base}/models`
with a bearer, and a null credential is an `invalid_request` that the API answers
as 400 ("add a key before importing the catalog"). `readPublicModelIds` is its
anonymous counterpart: one parser and one error mapping, no credential. Nous
Portal, Hyper, and OpenCode Go read their lists that way.

Prices are optional metadata. Each wire joins them its own way, and a failed join
leaves the models unpriced rather than failing the import:

| Provider     | Model list                         | Price join                                                                     |
| ------------ | ---------------------------------- | ------------------------------------------------------------------------------ |
| Token Harbor | keyed `/models`                    | none; every price is null                                                      |
| Yeta         | keyed `/models`                    | `GET {origin}/api/pricing`; input is `model_ratio * 2` USD/Mtok                |
| River        | public pricing JSON                | the list and the prices are the same document (`input`/`output`)               |
| Nous Portal  | public OpenRouter-shaped `/models` | `pricing.prompt`/`completion` per token, times 1e6                             |
| Kilo Code    | keyed gateway catalog              | `pricing.prompt`/`completion` per token, times 1e6                             |
| Hyper        | public `/models`                   | `pricing.input`/`output` already USD/Mtok, so no scaling                       |
| OpenCode Go  | public `/go/v1/models`, ids only   | the table's base-tier prices; a listed id the table cannot route never imports |
| Zro          | keyed `/v1/models`                 | the prices on its pricing page; an unknown id imports unpriced                 |

Yeta is a New API gateway: one ratio unit is $0.002 per 1K tokens, so a ratio is
worth $2 per million and the output price is the input price times
`completion_ratio`. `quota_type = 1` means per-call pricing, so those models get
null prices. Prices are the default group's; a key in another group pays that
group's `group_ratio`, which the import does not apply. The public pricing URL defaults to
`https://console.river.ai/api/public/pricing` and is overridden with
`providers.river.catalogUrl` in `config.json`, or with `BANDAR_RIVER_PRICING_URL`
when the file leaves it out. When that document cannot be read, River falls back to
its keyed `/models` list with null prices. Nous Portal keeps only models whose
`architecture.output_modalities` includes `text`.

Hyper quotes per-million-token prices and serves one wire, so its catalog imports
every id it lists with the published price. OpenCode Go is the opposite case: the
list carries no price and no wire, so the imported set is the table's callable
rows that the list contains, in table order.

Context windows and max output take a different path. A catalog that reports
them imports the numbers; otherwise bandar asks [models.dev](https://models.dev)
for the model id and stores what it finds. models.dev lists one id under many
providers with different numbers, so a lookup prefers the entry named like the
provider and otherwise takes the smallest context window: an overstated window
makes a tool send a request the model rejects, while an understated one only
truncates. A row with neither number stays null until someone edits it in the
model dialog, and the generated CLI configs write the numbers where the tool
accepts them.

## Errors

Adapters throw one type:

```ts
new UpstreamError(message, kind, status);
```

`kind` is one of `auth`, `rate_limit`, `invalid_request`, `not_found`,
`unavailable`, `protocol`, `network`, or `unknown`. `status` is the upstream HTTP
status when there was one. The gateway maps `rate_limit` to 429,
`invalid_request` to 400, `not_found` to 404, and the rest to 502, then records
the event with the error kind. `kindForStatus` answers `unknown` for a status it
does not classify, so an account-level status the gateway has no rule for does
not convict a subject.

Each failure that points at a subject also flags it: a credential for `auth` and
`rate_limit`, the provider for `unavailable` and `network`, the model for
`protocol` and `not_found`. `unknown` points at nobody, so the chain falls
through it without recording a flag. The gateway records the flag in SQLite and skips an attempt whose
subject is cooling down, so the next request does not repeat the same failure
until the cooldown ends.

Helpers in `src/server/providers/http.ts`:

- `joinUrl(baseUrl, "/path")` strips duplicate slashes.
- `postJson({ url, headers, body, signal })` turns a network failure into
  `UpstreamError(..., "network")` and passes an abort through.
- `postForm({ url, headers, form, signal })` sends a form-urlencoded body with
  the same network mapping.
- `requireOk(response)` reads an error envelope (`error.message`, `message`, or
  plain text) and classifies the status.
- `sseData(body, signal)` yields the joined `data:` lines of each SSE event, including one
  the upstream closes on without a trailing blank line.
- `apiKeyHeaders(name)` returns a `HeaderFactory` that omits the header when the
  upstream needs no key, and `bearerHeaders` is the `Authorization: Bearer` one.

## Wire mapping

|                | OpenAI                                            | Anthropic                                                    | Google GenAI                             | Kilo Code                                         | Token Harbor, Yeta, River                         | Nous Portal                                                  |
| -------------- | ------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------- | ------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------ |
| Chat URL       | `{base}/chat/completions`                         | `{base}/messages`                                            | `{base}/models/{model}:generateContent`  | `{base}/chat/completions`                         | `{base}/chat/completions`                         | `{base}/chat/completions`                                    |
| Stream URL     | same                                              | same                                                         | `...:streamGenerateContent?alt=sse`      | same                                              | same                                              | same                                                         |
| Auth header    | `Authorization: Bearer`                           | `x-api-key` + `anthropic-version: 2023-06-01`                | `x-goog-api-key`                         | `Authorization: Bearer` + optional org header     | `Authorization: Bearer`                           | `Authorization: Bearer` with the token from the device login |
| System prompt  | a `system` message                                | top-level `system`                                           | `systemInstruction`                      | a `system` message                                | a `system` message                                | a `system` message                                           |
| Assistant role | `assistant`                                       | `assistant`                                                  | `model`                                  | `assistant`                                       | `assistant`                                       | `assistant`                                                  |
| Max tokens     | `max_tokens`                                      | required `max_tokens` (default 1024)                         | `generationConfig.maxOutputTokens`       | `max_tokens`                                      | `max_tokens`                                      | `max_tokens`                                                 |
| Stop           | `stop`                                            | `stop_sequences`                                             | `generationConfig.stopSequences`         | `stop`                                            | `stop`                                            | `stop`                                                       |
| Stream usage   | final chunk, after `stream_options.include_usage` | `message_start` + `message_delta`                            | `usageMetadata` on chunks                | final chunk, after `stream_options.include_usage` | final chunk, after `stream_options.include_usage` | final chunk, after `stream_options.include_usage`            |
| Finish reason  | native                                            | `end_turn`/`stop_sequence` → `stop`, `max_tokens` → `length` | `STOP` → `stop`, `MAX_TOKENS` → `length` | native                                            | native                                            | native                                                       |

Anthropic and Google reject adjacent messages with the same role in some
configurations, so both adapters merge consecutive same-role messages. Every
other wire is the OpenAI chat shape, so it is passed through unchanged apart from
optional fields the canonical request does not carry. That is one adapter
implementation, not six: Kilo Code, Token Harbor, Yeta, River, Nous Portal, and
Hyper all differ only in their headers and their catalogs.

### Responses wire

`POST {base}/responses` with `{ model, input, stream?, max_output_tokens?,
temperature?, top_p? }`. `input` is the canonical messages, one item per message:
`{ role, content: [{ type: "input_text", text }] }`. A system message stays an
item; the wire's `instructions` field is not used.

The canonical `stop` has no Responses equivalent, so the adapter drops it. A model
that only speaks this wire cannot honour a stop sequence.

A non-streamed answer is the concatenation of every `output[]` item whose `type`
is `"message"`, through the `content[]` parts whose `type` is `"output_text"`.
Usage comes from `input_tokens` and `output_tokens`.

A stream carries typed events. `response.output_text.delta` is text;
`response.completed` and `response.incomplete` carry the response's `usage` and
`status`; `response.failed` and `error` throw a `protocolError`; any other event
type is ignored. `[DONE]` ends the stream when a proxy sends one.

The finish reason maps `completed` to `stop`, `incomplete` with
`max_output_tokens` to `length`, and passes any other incomplete reason through.

Kilo Code has two URLs: the OpenRouter-shaped gateway at
`https://api.kilo.ai/api/openrouter` for chat, and the catalog at
`https://api.kilo.ai/api/gateway/models`. Its `index.ts` builds the shared
adapter with its own header hook. `catalog.ts` in the same directory reads the
catalog for **Import catalog** and turns per-token pricing into
per-million-token prices. A `-1` price means Kilo routes the model dynamically
and is stored as `null`. River's catalog is its console's public pricing JSON,
which is why it can list models before any key is saved.

## Multi-wire gateways

OpenCode Go is one kind serving four compatibilities under one bearer. Its table
lives in `./src/server/providers/opencode/models.ts`; `compat.ts` in the same
directory holds the mounts and one `Record<Compat, WireRoute<"opencode">>`, so a
compat cannot be added without its mount and adapter:

| Compat      | Mount               | Adapter            | Auth                                          |
| ----------- | ------------------- | ------------------ | --------------------------------------------- |
| `chat`      | `/go/openai/v1`     | `chatAdapter`      | `Authorization: Bearer`                       |
| `responses` | `/go/openai/v1`     | `responsesAdapter` | `Authorization: Bearer`                       |
| `messages`  | `/go/anthropic/v1`  | `anthropicAdapter` | `Authorization: Bearer` + `anthropic-version` |
| `genai`     | `/go/google/v1beta` | `googleAdapter`    | `Authorization: Bearer`                       |

`opencodeDefaultCompat` looks the model up in the table and answers the row's
compat. An id the table does not list, or a row that is a gap, comes back as a
`null` compat with the reason, which the gateway turns into a 400 before any
request leaves the process. The catalog imports the mounts from the same module,
so the list and the chat path cannot disagree about where a wire lives.

Two rules keep a multi-wire catalog honest:

1. **The table is the authority; the live list is the gate.** Only rows that are
   both listed and callable import, in table order, so a model bandar cannot route
   never becomes a row the router will try.
2. **A gap is data, not an omission.** The eight ids the docs omit (`glm-5.1`,
   `grok-4.6`, `kimi-k2.6`, `minimax-m2.5`, `minimax-m2.7`, `omen-alpha`,
   `qwen3.6-plus`, `qwen3.7-max`) stay in the table with their reason, so a
   hand-added id fails with that reason instead of a generic error. The five ids
   the gateway serves only on the Responses wire (`grok-4.7`, `gpt-6-luna`,
   `gpt-5.6-luna`, `muse-spark-1.3-contributor`, `muse-spark-1.2-contributor`)
   route there and import unpriced, because the docs publish no price for them.

A single-wire gateway is the opposite policy: Hyper imports every id its public
list returns, because its one wire cannot list a model it cannot serve.

### Two wires at one base URL

Zro is the model-independent case. Both wires sit at its base URL — `POST
{base}/chat/completions` and `POST {base}/messages` — and every model it serves
answers on both, so `zro/index.ts` declares the two routes inline: no `mount`,
no per-model table, and no `compat.ts` record. The default is `always("chat")`,
the documented primary and the wire an OpenAI-shaped client speaks; a model moves
to Messages through the per-model override.

A `compat.ts` record earns its place when each model needs a different wire, as
on OpenCode Go. Where one default covers every model, the routes belong in
`index.ts` and the catalog takes its prices from a table rather than gating the
import on one.

Zro's catalog also folds ids: its `/v1/models` lists one model as both
`glm-5.3-flash` and `zro/glm-5.3-flash`, and both answer the same weights, so
`fetchZroCatalog` keeps the bare id its docs name and drops the prefixed twin. An
id listed only with the prefix imports as listed, and its address carries the prefix
twice, because an address prefixes the id the vendor answers to.

## Per-model compatibility

A provider row fixes the kind; a model row may fix its wire. The override lives in
`provider_models.compat` as raw text, with no default and no backfill, and only an
override is ever stored: `NULL` means "the provider's own default" in SQL, in
`resolvePlan`, in `routeAttempt`, and on the dashboard.

`routeAttempt` resolves an attempt's wire in one order: a declared override, then
the provider's `defaultCompat` for that upstream model, then a 400. An override the
kind no longer declares is treated as absent, so a row that outlives its wire
degrades to the default instead of failing the request. `parseCompat` reads the raw
column, so a value this build does not name comes back as `null`: the row shows
"Provider default" and answers there, and the next `PUT` overwrites the stored
value with one the build knows. A value this build does name but the kind no
longer declares is a different case: it stays in the row as a wire the provider
cannot serve, so the select lists it as unavailable instead of showing the
default.

The `Provider` value carries both sides of the decision per model, so the dashboard
never recomputes it:

- `compat` is the stored override, or `null`.
- `defaultCompat` is the wire the next request uses when no override is set, or
  `null` when the provider cannot route that id at all.
- `compats` on the provider is `compatsOf(kind)`: the list the model row offers.

`PUT /api/providers/:id/models/:modelId` takes `{ compat: Compat | null }` and
returns the whole provider, like the other model routes. It answers 404 when the
provider or the model does not exist, and 422 (`validation`) for a compat the kind
does not declare. A `null` body clears the override.

On OpenCode Go, `defaultCompat` is the table, so the override is how a listed id is
put on another wire. Importing a catalog never touches an existing row: a re-import
skips an upstream model it already has, so it cannot clobber a user's override.

A model's edit dialog carries one native select labelled `Protocol`. Its first
option is `Provider default (<wire>)`, or `Provider default
(no wire)` for a model the provider cannot route, then one option per
`provider.compats`. Choosing the default clears the column; the select is disabled
while a write is in flight.

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
   `BUILT_IN_PROVIDER_KINDS`, add its name, slug, and base URL to
   `BUILT_IN_PROVIDERS`, and add its label to `PROVIDER_KIND_LABELS`. A built-in
   also needs its three entries in `src/server/providers/endpoints.ts`
   (`PROVIDER_ENDPOINT_SPECS`, `PROVIDER_MOUNTS`, `DEFAULT_PROVIDER_ENDPOINTS`),
   its `endpoint("<kind>")` row in `resolveProviders` in `src/server/config.ts`,
   and its settings schema in `src/server/settings.ts`. Each is a
   `Record<BuiltInProviderKind, ...>` or a slice of one, so the type checker names
   the ones you skip.
2. Create `src/server/providers/<kind>/index.ts` with the definition, annotated
   with its own kind, and declare one route per wire it speaks. An
   OpenAI-compatible kind builds its chat adapter with `bearerAdapter("<kind>")`,
   or with `chatAdapter({ kind, label, headers })` when the wire needs its own
   headers. The other wires take `anthropicAdapter({ kind, label, headers })`,
   `googleAdapter({ kind, label, headers })`, and
   `responsesAdapter({ kind, label, headers })`. Add a `mount` for a wire that
   sits under a path of the base URL, and set `defaultCompat` with `always(...)`
   unless the choice depends on the model. Add an `OAuthConnector`, a
   `ProviderCatalog`, or a `CredentialRenewer` when the provider has one.
3. Register the definition in `genericDefinitions` or `builtInDefinitions` in
   `src/server/providers/registry.ts`. Both `satisfies` records report a missing
   entry, a wrong kind for the key, and a built-in without its `builtIn`
   settings.
4. Add a logo path to `LOGO_PATHS` and a base URL to `PLACEHOLDERS` in the
   client. The client's `Record<ProviderKind, ...>` tables fail until both exist.
5. Add the fake upstream routes and the checks that prove each capability: one
   streaming or non-streaming text/usage assertion per wire, plus one for every
   catalog, login, or renewal. The fake verifies the auth header too.
6. Run `bun run check && bun run test && bun run build && bun run smoke`.

No database migration is needed for a new kind: `providers.kind` is text and its
TypeScript type comes from `ProviderKind`. A credential row carries an
`auth_mode` column and a sealed bundle, so an API-key kind and an OAuth kind use
the same `provider_credentials` shape. `origin` separates a seeded built-in from a custom row. The
dashboard's kind picker, the add dialog, and the provider logo table read the
generic and built-in lists, so a new kind appears once it has a path in
`./src/client/components/provider-logo.tsx`.

## OAuth built-ins

Kilo Code and Nous Portal log in with a device code. A definition with an
`oauth` connector serves the `/api/providers/:id/oauth/{start,poll}` routes;
without one, both routes answer 400. The dashboard shows the **Connection** tab
when the kind's `authModes` includes `oauth`, so a new OAuth kind needs no client
branch.

The connector contract lives in `src/server/providers/types.ts`:

```ts
export interface OAuthConnector {
  start(signal: AbortSignal): Promise<DeviceLogin>;
  poll(code: string, signal: AbortSignal): Promise<DevicePollResult>;
}
```

`src/server/providers/kilocode/oauth.ts` and
`src/server/providers/nous/oauth.ts` implement it. The API keeps the device code
server-side, keyed by user and provider; the start response returns only the
short user code and the verification URL. The poll appends a credential with
`addOAuthCredential`, which seals the OAuth bundle and records `auth_mode =
"oauth"` on that row. An API key added later is another credential in the chain,
so the gateway can fall from the token to the key or the other way round, except
for Nous Portal, whose definition lists only `oauth` and whose credential routes
reject a key with `unsupported_mode`. A built-in provider's row is seeded before
login, so the Connection tab works on the first visit.

The connector returns the portal's poll interval with the code, and the dashboard
polls at that interval. Nous Portal's login posts `client_id=hermes-cli` and
`scope=inference:invoke` to `/api/oauth/device/code` and polls
`/api/oauth/token` with the device grant.
A 400 `authorization_pending` or `slow_down` is a pending poll; `expired_token`
or `access_denied` is an `invalid_request`. The token response supplies the
access token, the rotating refresh token, and `expires_in`, which become the
credential's `expiresAt`. A token without `expires_in` is a protocol error.

An OAuth connector that needs an account identifier should look it up during
`poll` and return it in the bundle, as Kilo Code does with `organizationId`. The
adapter then decides whether that identifier becomes a header.

## OAuth renewal

A definition may carry a `CredentialRenewer` beside its connector:

```ts
export type CredentialRenewal = {
  readonly credential: OAuthCredential;
  readonly signal: AbortSignal;
};

export interface CredentialRenewer {
  due(credential: OAuthCredential, now: number): boolean;
  renew(input: CredentialRenewal): Promise<Credential>;
}
```

`chat.ts` resolves each attempt's credential through `freshCredential`
(`src/server/providers/refresh.ts`) instead of reading it directly. That function
returns the stored credential unchanged unless the definition has a renewer, the
credential is OAuth, the renewer reports it due, and the attempt names a
credential row. Otherwise it renews once per row:

1. A map keyed by credential id is the single-flight slot. Every request that
   arrives while a renewal is in flight awaits the same promise, so a burst of
   chats rotates the refresh token once.
2. Inside the slot it re-reads the row by id. If the sealed value moved, another
   request already renewed it, and that stored credential is returned as is.
3. It calls `renew` with `AbortSignal.timeout(15_000)`, seals the result, and
   writes it with a compare-and-swap:
   `UPDATE provider_credentials SET credential = ?, auth_mode = 'oauth' WHERE id = ? AND credential = ?`.
   A lost race falls back to the stored row; a deleted row is an `auth` error.
4. If `renew` throws, it re-reads the row once. When the sealed value moved,
   another process already renewed, so the request continues with the stored
   credential. Otherwise the error is an `auth` failure: the gateway records the
   attempt and falls through to the next credential rather than sending a token
   the provider has already rejected.

Nous Portal's renewer is `src/server/providers/nous/renewal.ts`. It reports a
credential due 120 seconds before `expiresAt`, posts `grant_type=refresh_token`
with the refresh token in `x-nous-refresh-token`, stores the rotated token the
response carries, and maps a 400 `invalid_grant` to the "connection expired;
connect it again" auth error. A credential with no refresh token cannot renew and
fails the same way.

## Contract tests

The smoke run is the adapter conformance suite. It boots the compiled binary,
points one custom provider of each generic wire at a local fake upstream, checks
that the eight built-in rows were seeded with their auth modes and catalogs, drives
the gateway with a gateway key, and reads the analytics row back. That covers key
decryption, header construction, request translation, non-stream parsing, SSE
parsing, usage extraction, finish normalization, TTFT, and tokens-per-second.

The built-in checks go through fake catalog, pricing, and device-auth servers.
They import each catalog: one keyed with null prices, one keyed with a ratio join,
one keyed with a published price table, one public with per-token prices, one
public with per-million-token prices, and one public id list that must intersect a
built-in table. OpenCode Go answers one chat on each of its four wires, Zro one on
each of its two, and a hand-added undocumented model is a 400 with no upstream
request. They approve both device logins, prove Nous
Portal rejects an API key, call the gateway with each credential, renew a Nous
token under two concurrent chats and assert exactly one refresh with no replayed
refresh token, prove a spent refresh token and a credential without one are
`auth` failures, and prove a built-in row cannot be added, edited, removed, or
seeded twice.

Adapters whose wire differs in a way the fake does not model (for example, a
provider that sends usage only on a final event) should extend the fake and add
a focused check rather than mock the adapter in a unit test.
