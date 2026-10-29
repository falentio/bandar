import { describe, expect, test } from "vite-plus/test";
import {
  CLI_TOOLS,
  GATEWAY_SURFACE,
  KEY_PLACEHOLDER,
  MODEL_PLACEHOLDER,
  renderInput,
  toolById,
  toolStatus,
  type CliRenderInput,
  type CliSnippet,
  type CliTool,
  type CliToolId,
  type ModelLimit,
} from "./cli-tools";

const ORIGIN = "https://gw.example";
const KEY = "bandar_livekey000000000000";
const CODING = "tags/coding";
const KILO = "kilocode/anthropic/claude-sonnet-4.5";
const CHEAP = "tags/cheap";

const input = renderInput(ORIGIN, ["sonnet"], KEY);

const CAPACITY: Record<CliToolId, CliTool["modelCapacity"]> = {
  "opencode-v1": "many",
  "opencode-v2": "many",
  codex: "many",
  pi: "many",
  "claude-code": "one",
};

type FileSnippet = Extract<CliSnippet, { kind: "file" }>;

function fileSnippets(tool: CliTool, render: CliRenderInput): readonly FileSnippet[] {
  const files: FileSnippet[] = [];

  for (const snippet of tool.snippets(render)) {
    if (snippet.kind === "file") files.push(snippet);
  }

  return files;
}

function fileCode(tool: CliTool, render: CliRenderInput): string {
  return fileSnippets(tool, render)
    .map((snippet) => snippet.code)
    .join("\n");
}

function allCode(tool: CliTool, render: CliRenderInput): string {
  return tool
    .snippets(render)
    .map((snippet) => snippet.code)
    .join("\n");
}

describe("secrets", () => {
  test("no file snippet carries the key", () => {
    for (const tool of CLI_TOOLS) {
      for (const snippet of tool.snippets(input)) {
        if (snippet.kind === "shell") continue;

        expect(snippet.code, `${tool.id} writes the key into ${snippet.path}`).not.toContain(KEY);
      }
    }
  });

  test("every tool names the variable that supplies the key", () => {
    for (const tool of CLI_TOOLS) {
      expect(allCode(tool, input), `${tool.id} never mentions ${tool.keyVariable}`).toContain(
        tool.keyVariable,
      );
    }
  });

  test("a missing key stays a placeholder", () => {
    const blank = renderInput(ORIGIN, [], "");

    for (const tool of CLI_TOOLS) {
      const code = allCode(tool, blank);

      expect(code).not.toContain(KEY);
      expect(code).toContain(MODEL_PLACEHOLDER);
    }

    const pi = toolById("pi")
      .snippets(blank)
      .find((snippet) => snippet.kind === "shell");

    expect(pi?.code).toContain(KEY_PLACEHOLDER);
  });
});

describe("base urls", () => {
  test("Claude Code takes the origin and the rest take /v1", () => {
    for (const tool of CLI_TOOLS) {
      const expected = tool.id === "claude-code" ? ORIGIN : `${ORIGIN}/v1`;

      expect(tool.baseUrl(ORIGIN), tool.id).toBe(expected);
    }
  });

  test("the snippets agree with the declared base url", () => {
    for (const tool of CLI_TOOLS) {
      expect(allCode(tool, input), tool.id).toContain(tool.baseUrl(ORIGIN));
    }
  });

  test("a trailing slash on the origin is dropped", () => {
    expect(renderInput(`${ORIGIN}/`, [], "").origin).toBe(ORIGIN);
  });
});

describe("models", () => {
  test("every picked ref reaches a file snippet", () => {
    const two = renderInput(ORIGIN, [CODING, KILO], KEY);

    for (const tool of CLI_TOOLS) {
      const code = fileCode(tool, two);

      expect(code, tool.id).toContain(CODING);

      if (tool.id === "claude-code") {
        expect(code).not.toContain(KILO);
        continue;
      }

      expect(code, tool.id).toContain(KILO);
    }
  });

  test("the first ref is the default", () => {
    const two = renderInput(ORIGIN, [CODING, KILO], KEY);

    for (const id of ["opencode-v1", "opencode-v2"] as const) {
      const config: unknown = JSON.parse(fileCode(toolById(id), two));

      expect(config, id).toMatchObject({ model: "bandar/" + CODING });
    }

    const [defaultLine] = fileCode(toolById("codex"), two).split("\n");

    expect(defaultLine).toBe('model = "' + CODING + '"');
  });

  test("pi lists one entry per ref", () => {
    const two = renderInput(ORIGIN, [CODING, KILO], KEY);
    const pi = fileCode(toolById("pi"), two);

    expect(pi.match(/"id":/gu), "pi").toHaveLength(2);
  });

  test("codex writes one profile file per ref after the first", () => {
    const three = renderInput(ORIGIN, [CODING, KILO, CHEAP], KEY);
    const codex = toolById("codex");
    const [config, ...profiles] = fileSnippets(codex, three);

    expect(config?.path).toBe("~/.codex/config.toml");
    expect(config?.code.split("\n")[0]).toBe(`model = "${CODING}"`);
    expect(profiles.map((snippet) => snippet.path)).toEqual([
      "~/.codex/bandar-kilocode-anthropic-claude-sonnet-4-5.config.toml",
      "~/.codex/bandar-tags-cheap.config.toml",
    ]);
    expect(profiles.map((snippet) => snippet.code)).toEqual([
      `model = "${KILO}"`,
      `model = "${CHEAP}"`,
    ]);
    expect(fileSnippets(codex, input)).toHaveLength(1);
    expect(allCode(codex, three)).not.toContain("[profiles.");
  });

  test("Claude Code pins only the first of three refs", () => {
    const three = renderInput(ORIGIN, [CODING, KILO, CHEAP], KEY);
    const code = fileCode(toolById("claude-code"), three);

    expect(code).toContain(`"ANTHROPIC_MODEL": "${CODING}"`);
    expect(code).not.toContain(KILO);
    expect(code).not.toContain(CHEAP);
    expect(code).not.toContain("CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY");
  });

  test("an empty pick renders the placeholder in every tool", () => {
    const blank = renderInput(ORIGIN, [], KEY);

    for (const tool of CLI_TOOLS) {
      expect(fileCode(tool, blank), tool.id).toContain(MODEL_PLACEHOLDER);
    }
  });

  test("renderInput trims, drops blanks, and dedupes in pick order", () => {
    expect(renderInput(ORIGIN, ["  ", " sonnet ", "sonnet"], KEY).models).toEqual(["sonnet"]);
    expect(renderInput(ORIGIN, [" beta ", "alpha", "beta"], KEY).models).toEqual(["beta", "alpha"]);
  });

  test("every tool declares the capacity it implements", () => {
    for (const tool of CLI_TOOLS) {
      expect(["one", "many"], tool.id).toContain(tool.modelCapacity);
      expect(tool.modelCapacity, tool.id).toBe(CAPACITY[tool.id]);
    }
  });
});

describe("status", () => {
  test("a tool missing a served path is blocked and names the path", () => {
    const codex = toolStatus(toolById("codex"));

    expect(codex.status).toBe("blocked");
    expect(codex.reason).toContain("/v1/responses");
  });

  test("a chat tool names the stall and an Anthropic tool names the rejection", () => {
    expect(toolStatus(toolById("opencode-v1")).reason).toContain("tool loop stalls");
    expect(toolStatus(toolById("claude-code")).reason).toContain("422");
  });

  test("nothing is ready while the gateway drops tools", () => {
    if (GATEWAY_SURFACE.tools) return;

    expect(CLI_TOOLS.filter((tool) => toolStatus(tool).status === "ready")).toEqual([]);
  });
});

describe("token limits", () => {
  const limits = new Map([
    ["sonnet", { contextWindow: 200000, maxOutput: 64000, inputModalities: null }],
  ]);

  test("opencode writes the limit it knows and leaves the rest alone", () => {
    const render = renderInput(ORIGIN, ["sonnet", CODING], KEY, limits);
    const code = fileCode(toolById("opencode-v1"), render);

    expect(JSON.parse(code)).toMatchObject({
      provider: {
        bandar: {
          models: {
            sonnet: { name: "sonnet", limit: { context: 200000, output: 64000 } },
            [CODING]: { name: CODING },
          },
        },
      },
    });
  });

  test("pi writes contextWindow and maxTokens", () => {
    const render = renderInput(ORIGIN, ["sonnet", CODING], KEY, limits);

    expect(JSON.parse(fileCode(toolById("pi"), render))).toMatchObject({
      providers: {
        bandar: {
          models: [
            { id: "sonnet", name: "sonnet", contextWindow: 200000, maxTokens: 64000 },
            { id: CODING, name: CODING },
          ],
        },
      },
    });
  });

  test("a ref with no known limit carries no limit key", () => {
    const render = renderInput(ORIGIN, ["sonnet"], KEY);
    const code = fileCode(toolById("opencode-v1"), render);

    expect(code).toContain('"name": "sonnet"');
    expect(code).not.toContain('"limit"');
  });

  test("opencode writes input modalities and pi keeps text and image", () => {
    const withModalities = new Map<string, ModelLimit>([
      [
        "sonnet",
        {
          contextWindow: 200000,
          maxOutput: 64000,
          inputModalities: ["text", "image", "pdf"],
        },
      ],
    ]);

    const render = renderInput(ORIGIN, ["sonnet"], KEY, withModalities);

    expect(JSON.parse(fileCode(toolById("opencode-v1"), render))).toMatchObject({
      provider: {
        bandar: {
          models: { sonnet: { modalities: { input: ["text", "image", "pdf"] } } },
        },
      },
    });

    expect(JSON.parse(fileCode(toolById("pi"), render))).toMatchObject({
      providers: { bandar: { models: [{ id: "sonnet", input: ["text", "image"] }] } },
    });
  });

  test("a model with no modalities reported carries no modalities key", () => {
    const render = renderInput(ORIGIN, ["sonnet"], KEY, limits);

    expect(fileCode(toolById("opencode-v1"), render)).not.toContain('"modalities"');
    expect(fileCode(toolById("pi"), render)).not.toContain('"input"');
  });

  test("codex and claude code ignore limits", () => {
    const render = renderInput(ORIGIN, ["sonnet"], KEY, limits);

    for (const id of ["codex", "claude-code"] as const) {
      expect(fileCode(toolById(id), render)).not.toContain("limit");
    }
  });
});
