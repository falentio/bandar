import { describe, expect, test } from "vite-plus/test";
import type { ProviderKind } from "../../shared/providers";
import { definitionFor } from "./registry";
import { routeAttempt, type RoutedAttempt } from "./route";
import { UpstreamError, type ProviderTarget } from "./types";

function targetOf(kind: ProviderKind, baseUrl: string, upstreamModel: string): ProviderTarget {
  return {
    providerId: "provider",
    kind,
    baseUrl,
    credential: { authMode: "api-key", apiKey: "key" },
    upstreamModel,
  };
}

function failureOf(run: () => RoutedAttempt): UpstreamError {
  try {
    run();
  } catch (error) {
    if (error instanceof UpstreamError) return error;

    throw error;
  }

  throw new Error("expected the route to fail");
}

describe("routeAttempt", () => {
  test("no override takes the provider's default wire", () => {
    const target = targetOf("openai", "https://upstream.test/v1", "gpt-4o");

    const route = routeAttempt("openai", target, null);

    expect(route.adapter).toBe(definitionFor("openai").routes.chat?.adapter);
    expect(route.target.baseUrl).toBe("https://upstream.test/v1");
    expect(route.target.credential).toBe(target.credential);
  });

  test("a declared override wins, mount and all", () => {
    const target = targetOf("opencode", "https://upstream.test/inference", "glm-5.3");

    const route = routeAttempt("opencode", target, "messages");

    expect(route.adapter).toBe(definitionFor("opencode").routes.messages?.adapter);
    expect(route.target.baseUrl).toBe("https://upstream.test/inference/go/anthropic/v1");
  });

  test("an override the kind does not declare is ignored", () => {
    const target = targetOf("openai", "https://upstream.test/v1", "gpt-4o");

    const route = routeAttempt("openai", target, "genai");

    expect(route.adapter).toBe(definitionFor("openai").routes.chat?.adapter);
    expect(route.target.baseUrl).toBe("https://upstream.test/v1");
  });

  test("a default wire folds its mount in without a doubled slash", () => {
    const target = targetOf("opencode", "https://upstream.test/inference/", "gemini-4-argon");

    const route = routeAttempt("opencode", target, null);

    expect(route.adapter).toBe(definitionFor("opencode").routes.genai?.adapter);
    expect(route.target.baseUrl).toBe("https://upstream.test/inference/go/google/v1beta");
  });

  test("a model the kind cannot route is a 400 with the table's reason", () => {
    const target = targetOf("opencode", "https://upstream.test/inference", "omen-alpha");

    const error = failureOf(() => routeAttempt("opencode", target, null));

    expect(error.kind).toBe("invalid_request");
    expect(error.message).toContain("omen-alpha");
  });

  test("a declared override routes a model the table marks as a gap", () => {
    const target = targetOf("opencode", "https://upstream.test/inference", "omen-alpha");

    const route = routeAttempt("opencode", target, "chat");

    expect(route.adapter).toBe(definitionFor("opencode").routes.chat?.adapter);
    expect(route.target.baseUrl).toBe("https://upstream.test/inference/go/openai/v1");
  });

  test("a model no provider lists is a 400 that names it", () => {
    const target = targetOf("opencode", "https://upstream.test/inference", "not-a-go-model");

    const error = failureOf(() => routeAttempt("opencode", target, null));

    expect(error.kind).toBe("invalid_request");
    expect(error.message).toContain("not-a-go-model");
  });
});
