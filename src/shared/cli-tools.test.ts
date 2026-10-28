import { describe, expect, test } from "vite-plus/test";
import {
  CLI_TOOLS,
  GATEWAY_SURFACE,
  KEY_PLACEHOLDER,
  MODEL_PLACEHOLDER,
  renderInput,
  toolById,
  toolStatus,
} from "./cli-tools";

const ORIGIN = "https://gw.example";
const KEY = "bandar_livekey000000000000";

const input = renderInput(ORIGIN, "sonnet", KEY);

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
      const code = tool
        .snippets(input)
        .map((snippet) => snippet.code)
        .join("\n");

      expect(code, `${tool.id} never mentions ${tool.keyVariable}`).toContain(tool.keyVariable);
    }
  });

  test("a missing key stays a placeholder", () => {
    const blank = renderInput(ORIGIN, "", "");

    for (const tool of CLI_TOOLS) {
      const code = tool
        .snippets(blank)
        .map((snippet) => snippet.code)
        .join("\n");

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
      const code = tool
        .snippets(input)
        .map((snippet) => snippet.code)
        .join("\n");

      expect(code, tool.id).toContain(tool.baseUrl(ORIGIN));
    }
  });

  test("a trailing slash on the origin is dropped", () => {
    expect(renderInput(`${ORIGIN}/`, "", "").origin).toBe(ORIGIN);
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
