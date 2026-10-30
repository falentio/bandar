import * as v from "valibot";
import type { InputModality } from "./providers";

/** Which gateway ingress paths this build registers. Mirrors ./src/server/gateway.ts. */
export const GATEWAY_SURFACE = {
  chatCompletions: true,
  messages: true,
  responses: false,
  tools: true,
} as const;

export type GatewayNeed = keyof typeof GATEWAY_SURFACE;

export const GATEWAY_NEED_LABEL: Record<GatewayNeed, string> = {
  chatCompletions: "/v1/chat/completions",
  messages: "/v1/messages",
  responses: "/v1/responses",
  tools: "tool calling",
};

export const CLI_TOOL_IDS = ["opencode-v1", "opencode-v2", "codex", "claude-code", "pi"] as const;

export const CliToolIdSchema = v.picklist(CLI_TOOL_IDS);

export type CliToolId = v.InferOutput<typeof CliToolIdSchema>;

/** A snippet either writes a file or runs in a shell. Only a shell snippet may hold the key. */
export type CliSnippet =
  | {
      readonly kind: "file";
      readonly label: string;
      readonly path: string;
      readonly language: "json" | "toml";
      readonly code: string;
    }
  | {
      readonly kind: "shell";
      readonly label: string;
      readonly code: string;
    };

export type ModelLimit = {
  readonly contextWindow: number;
  readonly maxOutput: number;
  readonly inputModalities: readonly InputModality[] | null;
};

export type CliRenderInput = {
  readonly origin: string;
  /** Model refs as bandar resolves them. Index 0 is the tool's default. Empty renders the placeholder. */
  readonly models: readonly string[];
  /** Key shown once at creation, empty to render the placeholder. */
  readonly key: string;
  /** Token limits by model ref. A tag ref never gets one: the tag picks the model at request time. */
  readonly limits: ReadonlyMap<string, ModelLimit>;
};

export type CliTool = {
  readonly id: CliToolId;
  readonly name: string;
  readonly summary: string;
  readonly docsUrl: string;
  readonly needs: readonly GatewayNeed[];
  /** "many": one file lists every ref. "one": the file pins one ref and the tool lists the rest itself. */
  readonly modelCapacity: "one" | "many";
  /** Claude Code appends /v1/messages itself, every other tool wants /v1. */
  readonly baseUrl: (origin: string) => string;
  readonly keyVariable: string;
  readonly steps: readonly string[];
  readonly snippets: (input: CliRenderInput) => readonly CliSnippet[];
};

export type CliToolStatus = {
  readonly status: "ready" | "blocked";
  readonly reason: string;
};

export const KEY_PLACEHOLDER = "bandar_...";

export const MODEL_PLACEHOLDER = "<model>";

export function toolStatus(tool: CliTool): CliToolStatus {
  const missing = tool.needs.filter((need) => !GATEWAY_SURFACE[need]);

  if (missing.length > 0)
    return {
      status: "blocked",
      reason: `bandar does not serve ${missing.map((need) => GATEWAY_NEED_LABEL[need]).join(", ")} yet`,
    };

  return { status: "ready", reason: "requests and tool calls reach the model" };
}

export function renderInput(
  origin: string,
  models: readonly string[],
  key: string,
  limits: ReadonlyMap<string, ModelLimit> = new Map(),
): CliRenderInput {
  const trimmed = models.map((ref) => ref.trim());

  return {
    origin: origin.replace(/\/+$/u, ""),
    models: [...new Set(trimmed)].filter((ref) => ref !== ""),
    key: key.trim(),
    limits,
  };
}

export const CLI_TOOLS: readonly CliTool[] = [
  {
    id: "opencode-v1",
    name: "opencode (v1)",
    summary: "openai-compatible provider block in opencode.json",
    docsUrl: "https://opencode.ai/docs/providers/",
    needs: ["chatCompletions"],
    modelCapacity: "many",
    baseUrl: (origin) => `${origin}/v1`,
    keyVariable: "BANDAR_API_KEY",
    steps: [
      "Install opencode: npm i -g opencode-ai",
      "Add the provider block to ~/.config/opencode/opencode.json",
      "Export BANDAR_API_KEY before you start opencode",
      "Run opencode, then /models and pick the bandar model",
    ],
    snippets: (input) => [
      {
        kind: "file",
        label: "Provider block",
        path: "~/.config/opencode/opencode.json",
        language: "json",
        code: json({
          $schema: "https://opencode.ai/config.json",
          model: modelRef(activeOf(input)),
          provider: {
            bandar: {
              npm: "@ai-sdk/openai-compatible",
              name: "bandar",
              options: {
                baseURL: v1Of(input),
                apiKey: "{env:BANDAR_API_KEY}",
              },
              models: modelEntries(refsOf(input), input.limits),
            },
          },
        }),
      },
      {
        kind: "shell",
        label: "Key in the shell",
        code: `export BANDAR_API_KEY="${keyOf(input)}"`,
      },
    ],
  },
  {
    id: "opencode-v2",
    name: "opencode (v2)",
    summary: "providers block with an env credential in opencode.jsonc",
    docsUrl: "https://opencode.ai/v2/docs/providers/",
    needs: ["chatCompletions"],
    modelCapacity: "many",
    baseUrl: (origin) => `${origin}/v1`,
    keyVariable: "BANDAR_API_KEY",
    steps: [
      "Install opencode v2",
      "Add the providers block to ~/.config/opencode/opencode.jsonc",
      "Export BANDAR_API_KEY before you start opencode",
      "Run opencode, then /models and pick the bandar model",
    ],
    snippets: (input) => [
      {
        kind: "file",
        label: "Provider block",
        path: "~/.config/opencode/opencode.jsonc",
        language: "json",
        code: json({
          $schema: "https://opencode.ai/config.json",
          model: modelRef(activeOf(input)),
          providers: {
            bandar: {
              name: "bandar",
              env: ["BANDAR_API_KEY"],
              package: "@opencode/ai/providers/openai-compatible",
              settings: { baseURL: v1Of(input) },
              models: modelEntries(refsOf(input), input.limits),
            },
          },
        }),
      },
      {
        kind: "shell",
        label: "Key in the shell",
        code: `export BANDAR_API_KEY="${keyOf(input)}"`,
      },
    ],
  },
  {
    id: "codex",
    name: "Codex",
    summary: "custom model provider in config.toml",
    docsUrl: "https://developers.openai.com/codex/config-reference/",
    needs: ["responses"],
    modelCapacity: "many",
    baseUrl: (origin) => `${origin}/v1`,
    keyVariable: "BANDAR_API_KEY",
    steps: [
      "Install Codex: npm i -g @openai/codex",
      "Add the provider block to ~/.codex/config.toml",
      "Export BANDAR_API_KEY before you start codex",
      "Run codex for the first ref; for any later ref run codex --profile bandar-<slug>, which reads ~/.codex/bandar-<slug>.config.toml",
    ],
    snippets: (input) => [
      {
        kind: "file",
        label: "Provider block",
        path: "~/.codex/config.toml",
        language: "toml",
        code: [
          `model = "${activeOf(input)}"`,
          `model_provider = "bandar"`,
          "",
          "[model_providers.bandar]",
          `name = "bandar"`,
          `base_url = "${v1Of(input)}"`,
          `env_key = "BANDAR_API_KEY"`,
          `wire_api = "responses"`,
        ].join("\n"),
      },
      ...profileSnippets(refsOf(input)),
      {
        kind: "shell",
        label: "Key in the shell",
        code: `export BANDAR_API_KEY="${keyOf(input)}"`,
      },
    ],
  },
  {
    id: "claude-code",
    name: "Claude Code",
    summary: "Anthropic message endpoint through a credential helper",
    docsUrl: "https://code.claude.com/docs/en/llm-gateway-connect",
    needs: ["messages"],
    modelCapacity: "one",
    baseUrl: (origin) => origin,
    keyVariable: "ANTHROPIC_AUTH_TOKEN",
    steps: [
      "Install Claude Code: npm i -g @anthropic-ai/claude-code",
      "Save the key to ~/.config/bandar/key with no trailing newline, then chmod 600 that file",
      "Add the settings block to ~/.claude/settings.json, never to a project .claude/settings.json",
      "Run claude, then /status to confirm the base URL and the apiKeyHelper line",
      "Run /model to switch among Claude's own model entries; ANTHROPIC_DEFAULT_SONNET_MODEL, ANTHROPIC_DEFAULT_OPUS_MODEL and ANTHROPIC_DEFAULT_HAIKU_MODEL point one entry each at a bandar ref",
    ],
    snippets: (input) => [
      {
        kind: "file",
        label: "Settings block",
        path: "~/.claude/settings.json",
        language: "json",
        code: json({
          env: {
            ANTHROPIC_BASE_URL: input.origin,
            ANTHROPIC_MODEL: activeOf(input),
          },
          apiKeyHelper: "cat ~/.config/bandar/key",
        }),
      },
      {
        kind: "shell",
        label: "Shell alternative",
        code: [
          `export ANTHROPIC_BASE_URL="${input.origin}"`,
          `export ANTHROPIC_AUTH_TOKEN="${keyOf(input)}"`,
          `export ANTHROPIC_MODEL="${activeOf(input)}"`,
        ].join("\n"),
      },
    ],
  },
  {
    id: "pi",
    name: "pi coding agent",
    summary: "compatible endpoint in models.json",
    docsUrl: "https://pi.dev/models",
    needs: ["chatCompletions"],
    modelCapacity: "many",
    baseUrl: (origin) => `${origin}/v1`,
    keyVariable: "BANDAR_API_KEY",
    steps: [
      "Install the pi coding agent",
      "Add the provider block to ~/.pi/agent/models.json",
      "Export BANDAR_API_KEY before you start pi",
      "Run pi --list-models, then /model and pick the bandar model",
    ],
    snippets: (input) => [
      {
        kind: "file",
        label: "Provider block",
        path: "~/.pi/agent/models.json",
        language: "json",
        code: json({
          $schema: "https://pi.dev/schemas/models.schema.json",
          providers: {
            bandar: {
              baseUrl: v1Of(input),
              api: "openai-completions",
              apiKey: "$BANDAR_API_KEY",
              models: piEntries(refsOf(input), input.limits),
            },
          },
        }),
      },
      {
        kind: "shell",
        label: "Key in the shell",
        code: `export BANDAR_API_KEY="${keyOf(input)}"`,
      },
    ],
  },
];

export function toolById(id: CliToolId): CliTool {
  const tool = CLI_TOOLS.find((entry) => entry.id === id);

  if (tool === undefined) throw new Error(`no CLI tool for ${id}`);

  return tool;
}

function keyOf(input: CliRenderInput): string {
  return input.key === "" ? KEY_PLACEHOLDER : input.key;
}

function refsOf(input: CliRenderInput): readonly [string, ...string[]] {
  const [head = MODEL_PLACEHOLDER, ...rest] = input.models;

  return [head, ...rest];
}

function activeOf(input: CliRenderInput): string {
  return refsOf(input)[0];
}

function modelRef(ref: string): string {
  return `bandar/${ref}`;
}

type OpenCodeModelEntry = {
  name: string;
  limit?: { context: number; output: number };
  modalities?: { input: readonly InputModality[] };
};

function modelEntries(
  refs: readonly string[],
  limits: ReadonlyMap<string, ModelLimit>,
): Record<string, OpenCodeModelEntry> {
  return Object.fromEntries(
    refs.map((ref): [string, OpenCodeModelEntry] => {
      const limit = limits.get(ref);

      if (limit === undefined) return [ref, { name: ref }];

      const entry: OpenCodeModelEntry = {
        name: ref,
        limit: { context: limit.contextWindow, output: limit.maxOutput },
      };

      if (limit.inputModalities !== null && limit.inputModalities.length > 0) {
        entry.modalities = { input: limit.inputModalities };
      }

      return [ref, entry];
    }),
  );
}

type PiModelEntry = {
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: readonly InputModality[];
};

function piEntries(
  refs: readonly string[],
  limits: ReadonlyMap<string, ModelLimit>,
): readonly PiModelEntry[] {
  return refs.map((ref) => {
    const limit = limits.get(ref);

    if (limit === undefined) return { id: ref, name: ref };

    const entry: PiModelEntry = {
      id: ref,
      name: ref,
      contextWindow: limit.contextWindow,
      maxTokens: limit.maxOutput,
    };

    const accepted = limit.inputModalities?.filter(
      (modality) => modality === "text" || modality === "image",
    );

    if (accepted !== undefined && accepted.length > 0) entry.input = accepted;

    return entry;
  });
}

function profileSnippets(refs: readonly string[]): readonly CliSnippet[] {
  return refs.slice(1).map((ref): CliSnippet => ({
    kind: "file",
    label: `Profile for ${ref}`,
    path: `~/.codex/${codexProfile(ref)}.config.toml`,
    language: "toml",
    code: `model = "${ref}"`,
  }));
}

/** A Codex profile name accepts only letters, numbers, hyphens, and underscores. */
function codexProfile(ref: string): string {
  const slug = ref
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");

  return `bandar-${slug}`;
}

function v1Of(input: CliRenderInput): string {
  return `${input.origin}/v1`;
}

type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };

function json(value: Json): string {
  return JSON.stringify(value, null, 2);
}
