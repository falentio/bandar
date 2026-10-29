# Connect a coding tool

`/cli-tools` lists the five supported coding CLIs. Each one has a page at `/cli-tools/<tool id>` with the base URL, a key, and the config file that points it at bandar. You copy the text into place. bandar never writes a file on your machine, because the gateway is usually not on the same host as the editor.

Two gateway gaps decide what works today:

- The canonical request carries text only. A client that sends `tools` reaches the model without them, and an Anthropic request that sends a `tool_result` block gets a 422.
- There is no `/v1/responses` route.

The list and the detail page read both facts from `GATEWAY_SURFACE` in `./src/shared/cli-tools.ts` and print `ready`, `partial`, or `blocked` for each tool. A test in `./src/server/gateway-surface.test.ts` compares that constant with `./src/server/gateway.ts` and `./src/server/providers/types.ts`, and fails when they disagree, so the page cannot drift away from the server.

So every tool here connects and answers a prompt. None of them finishes a tool call yet, and Codex fails at the first request because it speaks only the Responses API. The repair list is at the end of this file.

## What the gateway serves

| Ingress                 | Path                        | Shape                              |
| ----------------------- | --------------------------- | ---------------------------------- |
| OpenAI chat completions | `/v1/chat/completions`      | text in, text out, streaming       |
| Anthropic messages      | `/v1/messages`              | text blocks, streaming             |
| Anthropic token count   | `/v1/messages/count_tokens` | estimate                           |
| Model list              | `/v1/models`                | addresses, provider refs, tag refs |

Not served: `/v1/responses`, tool definitions, tool results, images, prompt caching headers. A key travels as `Authorization: Bearer <key>` or `x-api-key: <key>`.

## Model refs

Every tool below needs the ref bandar resolves, not the vendor model name. Three forms work:

- an address, such as `sonnet`
- a provider ref, such as `kilocode/anthropic/claude-sonnet-4.5`
- a tag ref, such as `tags/coding`

Claude Code asks for `claude-sonnet-4-6` unless you set `ANTHROPIC_MODEL`. That name will not resolve unless a model carries it as its address, so set the variable.

On each setup page the model picker lists tags first, then each provider's models. Pick one ref or several: the first ref you pick is the tool's default. A tool that carries many refs writes every pick into the same file, so it switches between them without a second edit. A single-ref tool pins that one ref in its file and lists the rest itself.

The tools disagree about how a config holds several refs, and the picker follows each one:

| Tool              | How its config carries the refs                                                                                         | Switch inside the tool          |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| opencode (v1, v2) | one entry per ref in the provider's `models` map; the top-level `model` names the default                               | `/models`                       |
| Codex             | the default in `model`, and one profile file per ref after it                                                           | `codex --profile bandar-<slug>` |
| Claude Code       | one ref in `ANTHROPIC_MODEL`; the three `ANTHROPIC_DEFAULT_*_MODEL` variables point Claude's own entries at bandar refs | `/model`                        |
| pi                | one entry per ref in the `models` array; the file names no default                                                      | `/model`                        |

Claude Code cannot list models in its settings file. Its page therefore pins one starting ref in `ANTHROPIC_MODEL`, and the three alias variables are how `/model` gains bandar entries.

## Secret rules

These hold for every tool on the page. The snippets enforce the first one and a test checks it.

1. The key never goes into a config file you commit. Every file snippet points at an environment variable instead: `BANDAR_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or the `env` entry opencode v2 reads. Only shell snippets contain the key, and shell snippets are not files.
2. Use a user-level config, not a project-level one. `~/.claude/settings.json` is safe. `.claude/settings.json` in a repository is committed and shared with everyone who clones it.
3. When a tool needs a file, write it with mode 600. The Claude Code setup below puts the key in `~/.config/bandar/key` and sets `chmod 600` on it, then `apiKeyHelper` prints it. Background agents see that; they do not see a shell export.
4. Never pass the key as a command argument. It stays in shell history and in the process list. Put it in an environment variable or a file.
5. Prefer a command that fetches the key when it rotates. Claude Code calls `apiKeyHelper`, and pi interpolates `!command` in `models.json` at request time.
6. Create one key per tool. That way revoking a laptop leaves the others alone, and the Requests panel still tells you who called. Create and revoke on `/api-keys`.
7. A key over plain HTTP on an untrusted network is readable. Reach bandar over its tailnet name, a TLS proxy, or loopback.

The dashboard stores a hash plus the first characters, so a key is shown once, at creation, and never again. The page keeps the key in the browser tab only. It is not written to `localStorage`, the URL, or the server.

## opencode (v1)

Global config: `~/.config/opencode/opencode.json`. The provider block uses `@ai-sdk/openai-compatible` and reads the key with the `{env:...}` substitution:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "bandar/sonnet",
  "provider": {
    "bandar": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "bandar",
      "options": {
        "baseURL": "https://bandar.example/v1",
        "apiKey": "{env:BANDAR_API_KEY}"
      },
      "models": {
        "sonnet": { "name": "sonnet" },
        "tags/coding": { "name": "tags/coding" }
      }
    }
  }
}
```

```bash
export BANDAR_API_KEY="bandar_..."
opencode
```

`{file:~/.config/bandar/key}` also works where `{env:...}` does, and keeps the value out of the environment. A missing variable substitutes an empty string, so a 401 means the export never reached the process that started opencode.

Every key in `models` is a model opencode offers, and the top-level `model` is the one it starts on. `/models` opens the list, so a second ref costs one map entry and no restart.

Status: partial. opencode sends `tools` with every turn, bandar drops them, so the agent answers but never calls a tool.

## opencode (v2)

Global config: `~/.config/opencode/opencode.jsonc`. v2 moves providers under `providers` and names the credential variables in `env`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "bandar/sonnet",
  "providers": {
    "bandar": {
      "name": "bandar",
      "env": ["BANDAR_API_KEY"],
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": { "baseURL": "https://bandar.example/v1" },
      "models": {
        "sonnet": { "name": "sonnet" },
        "tags/coding": { "name": "tags/coding" }
      }
    }
  }
}
```

v2 stores credentials in its own database and imports the old `auth.json` on migration, so the `env` entry is the whole credential path here. Do not add a key field; the schema has none.

Status: partial, same reason as v1.

## Codex

Codex reads two files: `~/.codex/config.toml` for the provider, and one profile file per ref after the first. `env_key` keeps the key out of both:

```toml
model = "sonnet"
model_provider = "bandar"

[model_providers.bandar]
name = "bandar"
base_url = "https://bandar.example/v1"
env_key = "BANDAR_API_KEY"
wire_api = "responses"
```

Each ref after the first gets its own file next to `config.toml`, named after the ref. `~/.codex/bandar-tags-coding.config.toml` holds one top-level key:

```toml
model = "tags/coding"
```

`model` is the ref codex starts on, and it reaches bandar unchanged: no `bandar/` prefix, because the gateway matches the ref itself, whether that is an address, a provider ref, or a tag ref. Codex 0.134.0 and later ignores `[profiles.*]` tables in `config.toml`, so a profile is a file. It layers over `config.toml`, which leaves `model_provider` inherited. Start one with `codex --profile bandar-tags-coding`. A profile name accepts letters, numbers, hyphens, and underscores, so each ref is slugged: `tags/coding` becomes `bandar-tags-coding`, and `kilocode/anthropic/claude-sonnet-4.5` becomes `bandar-kilocode-anthropic-claude-sonnet-4-5`.

```bash
export BANDAR_API_KEY="bandar_..."
codex
codex --profile bandar-tags-coding
```

`wire_api` accepts `responses` and nothing else. The alternative, posting the key in `http_headers` or `experimental_bearer_token`, puts the secret in the file and the docs discourage it.

Status: blocked on `/v1/responses`. Nothing Codex sends reaches a model until bandar serves that route.

## Claude Code

Claude Code appends `/v1/messages` itself, so `ANTHROPIC_BASE_URL` is the origin with no path:

```bash
export ANTHROPIC_BASE_URL="https://bandar.example"
export ANTHROPIC_AUTH_TOKEN="bandar_..."
export ANTHROPIC_MODEL="sonnet"
claude
```

`ANTHROPIC_AUTH_TOKEN` sends `Authorization: Bearer`, and `ANTHROPIC_API_KEY` sends `x-api-key`. bandar accepts either. For a setup that survives a restart and reaches background agents, use `~/.claude/settings.json` with a credential helper:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://bandar.example",
    "ANTHROPIC_MODEL": "sonnet"
  },
  "apiKeyHelper": "cat ~/.config/bandar/key"
}
```

```bash
mkdir -p ~/.config/bandar
$EDITOR ~/.config/bandar/key
chmod 600 ~/.config/bandar/key
```

The key file holds one line and no trailing newline. Run `claude`, then `/status`: it lists the base URL and the `apiKeyHelper` line when the setup took.

`ANTHROPIC_MODEL` pins the model the session starts on. `/model` switches among Claude's own entries, and `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, and `ANTHROPIC_DEFAULT_HAIKU_MODEL` each point one of those entries at a bandar ref. Gateway discovery is not the path here: Claude Code keeps a discovered entry only when its id contains `claude` or `anthropic`, and bandar serves refs, so most refs would never appear.

Status: partial. The first prompt streams. As soon as Claude Code sends a `tool_result` block, bandar answers 422, because the text path rejects non-text blocks instead of dropping them.

## pi coding agent

Config: `~/.pi/agent/models.json`. pi resolves `$BANDAR_API_KEY` when it builds the request, not when it reads the file:

```json
{
  "$schema": "https://pi.dev/schemas/models.schema.json",
  "providers": {
    "bandar": {
      "baseUrl": "https://bandar.example/v1",
      "api": "openai-completions",
      "apiKey": "$BANDAR_API_KEY",
      "models": [
        { "id": "sonnet", "name": "sonnet" },
        { "id": "tags/coding", "name": "tags/coding" }
      ]
    }
  }
}
```

```bash
export BANDAR_API_KEY="bandar_..."
pi --list-models
```

`apiKey` accepts a literal, `$NAME`, `${NAME}`, or a leading `!command`. A command runs at request time, so a vault CLI works. Without `$BANDAR_API_KEY` set, pi reports the provider as unauthenticated instead of sending an empty key.

Each entry in `models` appears under `/model`, and pi keeps the one you used last, so the file carries no default.

Status: partial, same reason as opencode.

## Planned tools

9router carries about eighteen integrations. These are the rest, kept out of the page until the gaps below close:

| Tool                      | Config                                 | What it needs first                |
| ------------------------- | -------------------------------------- | ---------------------------------- |
| GitHub Copilot            | VS Code extension, base URL and key    | tool calling                       |
| Cline, Roo, Continue      | project config with an OpenAI base URL | tool calling                       |
| Kilo Code, Droid, Amp     | CLI or extension config                | tool calling                       |
| Open Claw, Hermes, jcode  | own config file                        | tool calling                       |
| Qwen Code                 | `~/.qwen/settings.json`                | tool calling                       |
| DeepSeek TUI, Grok Build  | `config.toml` with a custom model      | tool calling                       |
| Devin CLI                 | local binary through ACP               | nothing, it is not a routed client |
| Antigravity, Kiro, Cursor | MITM proxy and a root CA               | a decision, not code               |

The blockers, in the order they pay off:

1. Tool calling in the canonical layer. `CanonicalMessage.content` is a string and `CanonicalRequest` has no `tools`. Widen both to a block union, map `tool_calls` and `tool_use`, and forward `tools` on both ingresses. This one change turns every `partial` above into `ready`.
2. `/v1/responses` for Codex. It needs the same block work plus its own wire.
3. Vision blocks, so a CLI can attach a screenshot.
4. An optional local config writer. 9router edits files through its own API because it runs on the same machine as the CLI. Do this only for a gateway that runs locally, and gate it behind a flag, because a remote gateway writing into a laptop is not a feature.

## Adding a tool

Add an entry to `CLI_TOOLS` in `./src/shared/cli-tools.ts`: the ingress it needs, whether it needs tool calls, the base URL shape, the key variable, `modelCapacity`, the steps, and the snippets. `modelCapacity: "many"` means one file holds every picked ref, and the page renders the multi-select for it; `"one"` means the file pins a single ref and the tool lists the rest itself, and the page renders a single picker. A snippet reads `refsOf(input)` for the refs to write and `activeOf(input)` for the default, so a blank pick still renders the placeholder. The list page renders a row for it, `/cli-tools/<id>` renders the guide, and `toolStatus` computes the badge, so a new entry never hand-writes a status. Add the tool's mark to `CliToolLogo` in `./src/client/components/cli-tool-logo.tsx`; the paths there come from [svgl.app](https://svgl.app), which serves single-color marks, so a two-tone one carries an opacity instead of a second color.

Five rules the tests enforce, so keep them true:

- A snippet that names a file must reference the key variable and must not contain the key.
- The base URL in the snippets must equal `tool.baseUrl(origin)`.
- Every picked ref reaches the file snippet of a `"many"` tool, and a `"one"` tool's file carries only the first.
- Index 0 is the default line: the top-level `model` for opencode and Codex.
- Codex writes one profile file per ref after the first, and never a `[profiles.*]` table.

When an ingress lands, flip its flag in `GATEWAY_SURFACE`. The drift test in `./src/server/gateway-surface.test.ts` fails until the flag matches `./src/server/gateway.ts` and `./src/server/providers/types.ts`, and the badges follow.

## Check the setup

```bash
curl -sS "$ANTHROPIC_BASE_URL/v1/models" -H "Authorization: Bearer $BANDAR_API_KEY"
```

The model list proves the URL and the key. Then send one chat turn:

```bash
curl -sS "${ANTHROPIC_BASE_URL:-http://localhost:4133}/v1/chat/completions" \
  -H "Authorization: Bearer $BANDAR_API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"sonnet","messages":[{"role":"user","content":"say hi"}]}'
```

A 404 names an unresolvable model ref. A 401 names the key. A 422 on a tool result means the text-only limit above, not a broken key.
