import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { ApiErrorBodySchema, HealthSchema, type ApiErrorBody } from "../src/shared/api";
import { API_KEY_HEADER, CreatedApiKeySchema } from "../src/shared/api-keys";
import { AuthResultSchema } from "../src/shared/auth";
import { NoteListSchema, NoteSchema } from "../src/shared/notes";

const BINARY = join(import.meta.dir, "../dist/bandar");
const JOURNAL = join(import.meta.dir, "../drizzle/meta/_journal.json");
const AUTH_SECRET = "smoke-secret-0123456789abcdef0123456789abcdef";

type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };

type Journal = { readonly entries: readonly { readonly idx: number; readonly tag: string }[] };

type Booted = {
  readonly origin: string;
  readonly log: () => string;
  readonly stop: () => Promise<void>;
};

const expectedMigration = lastJournalTag();
const workDir = mkdtempSync(join(tmpdir(), "bandar-smoke-"));
const dbPath = join(workDir, "smoke.db");
const created = { id: 0, body: "smoke note" };
const authEmail = `${Date.now()}@smoke.test`;
const authPassword = "smoke-password-1";

let failures = 0;
let cookie = "";
let apiKey = "";
let keyId = "";

const first = await boot(await reservePort());
const origin = first.origin;
const requestOrigin = `http://localhost:${new URL(origin).port}`;

try {
  await check("GET / serves the client shell", async () => {
    const response = await fetch(new URL("/", origin));
    assert.equal(response.status, 200);
    assert.match(contentType(response), /^text\/html/);
    assert.match(await response.text(), /id="root"/);
  });

  await check("the referenced JS asset is served as javascript", async () => {
    const html = await (await fetch(new URL("/", origin))).text();
    const asset = html.match(/src="([^"]*\/assets\/[^"]+\.js)"/)?.[1];
    assert.ok(asset, "index.html references no hashed JS asset");

    const response = await fetch(new URL(asset, origin));
    assert.equal(response.status, 200);
    assert.match(contentType(response), /javascript/);
    assert.match(response.headers.get("cache-control") ?? "", /immutable/);
  });

  await check("HEAD / returns the headers without a body", async () => {
    const response = await fetch(new URL("/", origin), { method: "HEAD" });
    assert.equal(response.status, 200);
    assert.match(contentType(response), /^text\/html/);
    assert.ok(Number(response.headers.get("content-length")) > 0, "HEAD reports no content-length");
    assert.equal((await response.text()).length, 0);
  });

  await check("GET /api/health reports the embedded migration", async () => {
    const health = await getJson("/api/health", HealthSchema, 200);
    assert.equal(health.migration, expectedMigration);
  });

  await check("GET /api/notes without a session is 401", async () => {
    const response = await fetch(new URL("/api/notes", origin));
    assert.equal(response.status, 401);
    assert.equal((await errorBody(response)).code, "unauthorized");
  });

  await check("POST /api/auth/sign-up/email starts a session", async () => {
    const response = await post(
      "/api/auth/sign-up/email",
      { name: "Smoke", email: authEmail, password: authPassword },
      { origin: requestOrigin },
    );

    assert.equal(response.status, 200);

    const result = v.parse(AuthResultSchema, await response.json());
    assert.equal(result.user.email, authEmail);

    cookie = sessionCookie(response);
  });

  await check("POST /api/notes creates a note", async () => {
    const note = await postJson("/api/notes", { body: created.body }, NoteSchema, 201);
    assert.equal(note.body, created.body);
    created.id = note.id;
  });

  await check("GET /api/notes lists the created note", async () => {
    const notes = await getJson("/api/notes", NoteListSchema, 200);
    assert.ok(
      notes.some((note) => note.id === created.id),
      `note ${created.id} is missing from the list`,
    );
  });

  await check("POST /api/auth/api-key/create mints a bandar_ key", async () => {
    const response = await post(
      "/api/auth/api-key/create",
      { name: "smoke key" },
      { origin: requestOrigin },
    );

    assert.equal(response.status, 200);

    const minted = v.parse(CreatedApiKeySchema, await response.json());
    assert.ok(minted.key.startsWith("bandar_"), `key ${minted.key} lacks the bandar_ prefix`);

    apiKey = minted.key;
    keyId = minted.id;
  });

  await check("an API key alone creates, lists and deletes a note", async () => {
    const response = await fetch(new URL("/api/notes", origin), {
      method: "POST",
      headers: { "content-type": "application/json", ...keyHeaders() },
      body: JSON.stringify({ body: "note from a key" }),
    });

    assert.equal(response.status, 201);

    const note = v.parse(NoteSchema, await response.json());
    const listed = await fetch(new URL("/api/notes", origin), { headers: keyHeaders() });

    assert.equal(listed.status, 200);
    assert.ok(
      v.parse(NoteListSchema, await listed.json()).some((item) => item.id === note.id),
      `note ${note.id} is missing from the key's list`,
    );

    const removed = await fetch(new URL(`/api/notes/${note.id}`, origin), {
      method: "DELETE",
      headers: keyHeaders(),
    });

    assert.equal(removed.status, 204);
  });

  await check("DELETE /api/notes/:id removes the note once", async () => {
    const response = await fetch(new URL(`/api/notes/${created.id}`, origin), {
      method: "DELETE",
      headers: sessionHeaders(),
    });

    assert.equal(response.status, 204);

    const again = await fetch(new URL(`/api/notes/${created.id}`, origin), {
      method: "DELETE",
      headers: sessionHeaders(),
    });

    assert.equal(again.status, 404);
    assert.equal((await errorBody(again)).code, "not_found");
  });

  await check("POST /api/notes with an empty body is a validation error", async () => {
    const response = await post("/api/notes", { body: "" });
    assert.equal(response.status, 422);
    const error = await errorBody(response);
    assert.equal(error.code, "validation");
    assert.ok(error.issues.length > 0, "the validation error carries no issues");
    assert.ok(
      error.issues.some((issue) => issue.startsWith("body:")),
      `the issues do not name the field: ${error.issues.join(", ")}`,
    );
  });

  await check("POST /api/auth/sign-out ends the session", async () => {
    const response = await post("/api/auth/sign-out", {}, { origin: requestOrigin });
    assert.equal(response.status, 200);
  });

  await check("the old session cookie no longer lists notes", async () => {
    const response = await fetch(new URL("/api/notes", origin), { headers: sessionHeaders() });
    assert.equal(response.status, 401);
    assert.equal((await errorBody(response)).code, "unauthorized");
    cookie = "";
  });

  await check("a revoked API key is 401 unauthorized", async () => {
    const signIn = await post(
      "/api/auth/sign-in/email",
      { email: authEmail, password: authPassword },
      { origin: requestOrigin },
    );

    assert.equal(signIn.status, 200);
    cookie = sessionCookie(signIn);

    const revoked = await post("/api/auth/api-key/delete", { keyId }, { origin: requestOrigin });
    assert.equal(revoked.status, 200);

    const signOut = await post("/api/auth/sign-out", {}, { origin: requestOrigin });
    assert.equal(signOut.status, 200);
    cookie = "";

    const response = await fetch(new URL("/api/notes", origin), { headers: keyHeaders() });
    assert.equal(response.status, 401);
    assert.equal((await errorBody(response)).code, "unauthorized");
  });

  await check("a garbage x-api-key is 401 unauthorized", async () => {
    const response = await fetch(new URL("/api/notes", origin), {
      headers: keyHeaders("bandar_not-a-real-key"),
    });

    assert.equal(response.status, 401);
    assert.equal((await errorBody(response)).code, "unauthorized");
  });

  await check("an unknown /api route is a JSON 404", async () => {
    const response = await fetch(new URL("/api/nope", origin));
    assert.equal(response.status, 404);
    assert.match(contentType(response), /application\/json/);
    assert.equal((await errorBody(response)).code, "not_found");
  });

  await check("an unknown page falls back to the SPA shell", async () => {
    const response = await fetch(new URL("/nope", origin));
    assert.equal(response.status, 200);
    assert.match(contentType(response), /^text\/html/);
    assert.match(await response.text(), /id="root"/);
  });
} finally {
  await first.stop();
}

const second = await boot();

try {
  await check("a second boot applies no migrations", async () => {
    assert.match(second.log(), /migrations: 0 applied/);

    const health = await getJson("/api/health", HealthSchema, 200, second.origin);
    assert.equal(health.migration, expectedMigration);
  });
} finally {
  await second.stop();
  rmSync(workDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`smoke failed: ${failures} check(s)`);
  process.exit(1);
}

console.log("smoke ok");

async function check(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`not ok - ${name}`);
    console.error(`  ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function boot(port = 0): Promise<Booted> {
  if (!existsSync(BINARY)) throw new Error(`${BINARY} is missing; run \`bun run build\` first`);

  const proc = Bun.spawn([BINARY], {
    env: {
      ...Bun.env,
      BANDAR_PORT: String(port),
      BANDAR_DB: dbPath,
      BANDAR_AUTH_SECRET: AUTH_SECRET,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const decoder = new TextDecoder();
  let log = "";
  const stderr = new Response(proc.stderr).text().catch(() => "");

  void (async () => {
    const reader = proc.stdout.getReader();

    for (;;) {
      const { value, done } = await reader.read();

      if (done) return;
      log += decoder.decode(value, { stream: true });
    }
  })();

  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    const found = log.match(/listening on (http:\/\/\S+)/)?.[1];

    if (found) return { origin: found, log: () => log, stop: () => stop(proc) };

    if (proc.exitCode !== null)
      throw new Error(`the binary exited with ${proc.exitCode}\n${await stderr}`);
    await Bun.sleep(25);
  }

  proc.kill();
  throw new Error(`the binary never reported a port\n${await stderr}`);
}

async function stop(proc: Bun.Subprocess): Promise<void> {
  proc.kill();
  await proc.exited;
}

async function getJson<T>(
  path: string,
  schema: v.GenericSchema<T>,
  status: number,
  base: string = origin,
): Promise<T> {
  const response = await fetch(new URL(path, base), { headers: sessionHeaders() });
  assert.equal(response.status, status);

  return v.parse(schema, await response.json());
}

async function postJson<T>(
  path: string,
  body: Json,
  schema: v.GenericSchema<T>,
  status: number,
): Promise<T> {
  const response = await post(path, body);
  assert.equal(response.status, status);

  return v.parse(schema, await response.json());
}

async function post(
  path: string,
  body: Json,
  headers: Readonly<Record<string, string>> = {},
): Promise<Response> {
  return fetch(new URL(path, origin), {
    method: "POST",
    headers: { "content-type": "application/json", ...sessionHeaders(), ...headers },
    body: JSON.stringify(body),
  });
}

async function errorBody(response: Response): Promise<ApiErrorBody["error"]> {
  return v.parse(ApiErrorBodySchema, await response.json()).error;
}

function sessionHeaders(): Record<string, string> {
  return cookie === "" ? {} : { cookie };
}

function keyHeaders(key: string = apiKey) {
  return { [API_KEY_HEADER]: key, cookie: "" };
}

function sessionCookie(response: Response): string {
  const setCookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith("better-auth.session_token="));

  assert.ok(setCookie, "the response set no better-auth.session_token cookie");

  const pair = setCookie.split(";")[0];
  assert.ok(pair);

  return pair;
}

function contentType(response: Response): string {
  return response.headers.get("content-type") ?? "";
}

function reservePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port;

  return probe.stop().then(() => {
    if (port === undefined) throw new Error("Bun.serve reported no port");

    return port;
  });
}

function lastJournalTag(): string {
  // SAFETY: drizzle-kit wrote this journal; only entries[].idx and entries[].tag are read.
  const journal = JSON.parse(readFileSync(JOURNAL, "utf8")) as Journal;

  const last = [...journal.entries].sort((a, b) => a.idx - b.idx).at(-1);

  if (!last) throw new Error(`${JOURNAL} has no migration entries`);

  return last.tag;
}
