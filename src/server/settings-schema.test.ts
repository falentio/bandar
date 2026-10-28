import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { describe, expect, test } from "vite-plus/test";
import { loadSettings } from "./settings";
import { settingsSchema } from "./settings-schema";

const ajv = new Ajv2020({ allErrors: true, strict: true });

addFormats(ajv);

const validate = ajv.compile(settingsSchema);

const home = "/home/andrew/.bandar";

type Verdict = "accepted" | "rejected";

type Case = {
  readonly name: string;
  readonly text: string;
  readonly verdict: Verdict;
};

type Exception = {
  readonly name: string;
  readonly reason: string;
  readonly text: string;
};

const agreeing: readonly Case[] = [
  { name: "plain minimal", text: "{}", verdict: "accepted" },
  { name: "host with spaces", text: '{"server":{"host":"   "}}', verdict: "rejected" },
  { name: "host padded", text: '{"server":{"host":" 127.0.0.1 "}}', verdict: "accepted" },
  { name: "$schema blank", text: '{"$schema":" "}', verdict: "rejected" },
  {
    name: "$schema remote",
    text: '{"$schema":"https://example.com/schema.json"}',
    verdict: "accepted",
  },
  {
    name: "authUrl uppercase scheme",
    text: '{"server":{"authUrl":"HTTPS://llm.example.com"}}',
    verdict: "accepted",
  },
  {
    name: "authUrl with credentials",
    text: '{"server":{"authUrl":"https://user:secret@llm.example.com/api"}}',
    verdict: "accepted",
  },
  {
    name: "authUrl with a port",
    text: '{"server":{"authUrl":"https://llm.example.com:8443/api"}}',
    verdict: "accepted",
  },
  {
    name: "authUrl with a non-numeric port",
    text: '{"server":{"authUrl":"https://llm.example.com:abc"}}',
    verdict: "rejected",
  },
  {
    name: "authUrl with no authority",
    text: '{"server":{"authUrl":"https://"}}',
    verdict: "rejected",
  },
  {
    name: "authUrl javascript:",
    text: '{"server":{"authUrl":"javascript:alert(1)"}}',
    verdict: "rejected",
  },
  {
    name: "origin uppercase scheme",
    text: '{"server":{"trustedOrigins":["HTTPS://LLM.EXAMPLE.COM"]}}',
    verdict: "accepted",
  },
  {
    name: "origin uppercase host",
    text: '{"server":{"trustedOrigins":["https://X.COM/"]}}',
    verdict: "accepted",
  },
  {
    name: "origin credentials",
    text: '{"server":{"trustedOrigins":["https://user:secret@llm.example.com"]}}',
    verdict: "rejected",
  },
  {
    name: "origin with a non-numeric port",
    text: '{"server":{"trustedOrigins":["https://llm.example.com:abc"]}}',
    verdict: "rejected",
  },
  {
    name: "origin with a trailing slash",
    text: '{"server":{"trustedOrigins":["https://llm.example.com/"]}}',
    verdict: "accepted",
  },
  {
    name: "origin with a path",
    text: '{"server":{"trustedOrigins":["https://llm.example.com/api"]}}',
    verdict: "rejected",
  },
  {
    name: "origin on an ipv6 loopback",
    text: '{"server":{"trustedOrigins":["http://[::1]:3000"]}}',
    verdict: "accepted",
  },
  { name: "port 0", text: '{"server":{"port":0}}', verdict: "accepted" },
  { name: "port 70000", text: '{"server":{"port":70000}}', verdict: "rejected" },
  { name: "port 80.5", text: '{"server":{"port":80.5}}', verdict: "rejected" },
  { name: "empty origins", text: '{"server":{"trustedOrigins":[]}}', verdict: "rejected" },
  { name: "unknown key", text: '{"nope":true}', verdict: "rejected" },
];

/**
 * The exception table: a document the server boots and the schema rejects. Each row carries the
 * reason it cannot agree, and a row that stops being an exception fails the test. A divergence the
 * other way, the schema accepting a document that refuses to boot, is never tolerated.
 */
const exceptions: readonly Exception[] = [
  {
    name: "authUrl padded",
    reason: "the parser trims the value before it checks it; a pattern matches the raw string",
    text: '{"server":{"authUrl":" https://llm.example.com "}}',
  },
  {
    name: "origin padded",
    reason: "the parser trims the value before it checks it; a pattern matches the raw string",
    text: '{"server":{"trustedOrigins":[" https://llm.example.com "]}}',
  },
  {
    name: "authUrl with a trailing space",
    reason: "the URL API drops a trailing space and the pattern does not",
    text: '{"server":{"authUrl":"https://llm.example.com "}}',
  },
];

const schemaVerdict = (text: string): Verdict =>
  validate(JSON.parse(text)) === true ? "accepted" : "rejected";

const bootVerdict = (text: string): Verdict =>
  loadSettings(home, { read: () => text, write: () => {} }).kind === "ok" ? "accepted" : "rejected";

describe("the schema beside the settings", () => {
  test("every document lands on the same verdict in the editor and at boot", () => {
    const diverged = agreeing.filter(
      (row) => schemaVerdict(row.text) !== row.verdict || bootVerdict(row.text) !== row.verdict,
    );

    expect(diverged).toEqual([]);
  });

  test("the exceptions it keeps are padded values, and every row still is one", () => {
    const stale = exceptions.filter(
      (row) => schemaVerdict(row.text) !== "rejected" || bootVerdict(row.text) !== "accepted",
    );

    expect(stale).toEqual([]);
  });
});
