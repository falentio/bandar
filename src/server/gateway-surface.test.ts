import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { GATEWAY_SURFACE } from "../shared/cli-tools";

const gateway = readFileSync(new URL("./gateway.ts", import.meta.url), "utf8");
const chat = readFileSync(new URL("../shared/chat.ts", import.meta.url), "utf8");

describe("cli tools surface", () => {
  test("every flag matches a route the gateway registers", () => {
    expect(GATEWAY_SURFACE.chatCompletions).toBe(gateway.includes('.post("/chat/completions"'));
    expect(GATEWAY_SURFACE.messages).toBe(gateway.includes('.post("/messages"'));
    expect(GATEWAY_SURFACE.responses).toBe(gateway.includes('.post("/responses"'));
    expect(GATEWAY_SURFACE.tools).toBe(chat.includes("tools:"));
  });
});
