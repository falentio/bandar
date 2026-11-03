import { describe, expect, test } from "vite-plus/test";
import {
  budgetExceeded,
  codeOfBody,
  isBudgetCode,
  requireOk,
  resetFrom,
  retryAfterOf,
} from "./http";
import { UpstreamError } from "./types";

const ZRO_BODY = JSON.stringify({
  error: {
    message:
      "You've used today's Free usage. It resets in 6h 11m. Add a usage pack or choose a plan to keep going: https://zro.moonmath.ai/billing",
    type: "budget_exceeded",
    code: "budget_exceeded",
    param: null,
    top_up_url: "https://zro.moonmath.ai/billing",
  },
});

function rejectionOf(body: string, status = 429, headers: Record<string, string> = {}) {
  return { status, body, headers: new Headers(headers) };
}

function minutesOf(at: Date | null): number | null {
  return at === null ? null : Math.round((at.getTime() - Date.now()) / 60_000);
}

describe("codeOfBody", () => {
  test("reads the code a nested error carries", () => {
    expect(codeOfBody(ZRO_BODY)).toBe("budget_exceeded");
  });

  test("reads a bare top-level code", () => {
    expect(codeOfBody(JSON.stringify({ code: "insufficient_quota" }))).toBe("insufficient_quota");
  });

  test("is null for a body with no code, or no JSON", () => {
    expect(codeOfBody(JSON.stringify({ error: { message: "slow down" } }))).toBeNull();
    expect(codeOfBody("not json")).toBeNull();
  });
});

describe("isBudgetCode", () => {
  test("knows the vendor words for an exhausted allowance", () => {
    expect(isBudgetCode("budget_exceeded")).toBe(true);
    expect(isBudgetCode("insufficient_quota")).toBe(true);
    expect(isBudgetCode("rate_limit_exceeded")).toBe(false);
    expect(isBudgetCode(null)).toBe(false);
  });
});

describe("resetFrom", () => {
  test("reads the countdown out of the vendor message", () => {
    expect(minutesOf(resetFrom(ZRO_BODY))).toBe(371);
  });

  test("adds several parts", () => {
    const body = JSON.stringify({ error: { message: "resets in 1h 30m" } });

    expect(minutesOf(resetFrom(body))).toBe(90);
  });

  test("is null when the message names no duration", () => {
    expect(resetFrom(JSON.stringify({ error: { message: "add a usage pack" } }))).toBeNull();
    expect(resetFrom("not json")).toBeNull();
  });

  test("caps a refill at one day", () => {
    const body = JSON.stringify({ error: { message: "resets in 30d" } });

    expect(minutesOf(resetFrom(body))).toBe(1440);
  });
});

describe("retryAfterOf", () => {
  test("reads seconds as a wait from now", () => {
    expect(minutesOf(retryAfterOf(new Headers({ "retry-after": "120" })))).toBe(2);
  });

  test("reads an http date", () => {
    const at = new Date(Date.now() + 90 * 60_000).toUTCString();

    expect(minutesOf(retryAfterOf(new Headers({ "retry-after": at })))).toBe(90);
  });

  test("is null without the header, and for a past date", () => {
    expect(retryAfterOf(new Headers())).toBeNull();
    expect(retryAfterOf(new Headers({ "retry-after": new Date(0).toUTCString() }))).toBeNull();
  });
});

describe("budgetExceeded", () => {
  test("names the kind and keeps the vendor's own refill time", () => {
    const error = budgetExceeded(rejectionOf(ZRO_BODY));

    expect(error.kind).toBe("budget_exceeded");
    expect(error.status).toBe(429);
    expect(error.message).toContain("used today's Free usage");
    expect(minutesOf(error.resetsAt)).toBe(371);
  });

  test("falls back to the header when the message names no time", () => {
    const error = budgetExceeded(
      rejectionOf(JSON.stringify({ code: "budget_exceeded" }), 402, { "retry-after": "60" }),
    );

    expect(minutesOf(error.resetsAt)).toBe(1);
  });
});

describe("requireOk", () => {
  const budgetOnly = (rejection: Parameters<typeof budgetExceeded>[0]) =>
    isBudgetCode(codeOfBody(rejection.body)) ? budgetExceeded(rejection) : null;

  test("passes a classified 200 through when nothing matched", async () => {
    const response = Response.json({ choices: [] });

    await expect(requireOk(response, budgetOnly)).resolves.toBeUndefined();
  });

  test("throws what a classifier named in an OK body", async () => {
    const response = Response.json(JSON.parse(ZRO_BODY));

    await expect(requireOk(response, budgetOnly)).rejects.toBeInstanceOf(UpstreamError);
  });

  test("keeps the status classification for a failure the classifier passes on", async () => {
    const response = Response.json({ error: { message: "slow down" } }, { status: 429 });

    await expect(requireOk(response, budgetOnly)).rejects.toMatchObject({
      kind: "rate_limit",
      status: 429,
    });
  });

  test("classifies a failure the way it classifies a body", async () => {
    const response = Response.json(JSON.parse(ZRO_BODY), { status: 402 });

    await expect(requireOk(response, budgetOnly)).rejects.toMatchObject({
      kind: "budget_exceeded",
    });
  });

  test("maps a bare 402 to a budget with no classifier", async () => {
    const response = Response.json({ error: { message: "payment required" } }, { status: 402 });

    await expect(requireOk(response)).rejects.toMatchObject({ kind: "budget_exceeded" });
  });
});
