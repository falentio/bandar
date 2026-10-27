import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiErrorBodySchema, HealthSchema } from "../src/shared/api";
import { NoteSchema } from "../src/shared/notes";

const BINARY = join(import.meta.dir, "../dist/bandar");
const JOURNAL = join(import.meta.dir, "../drizzle/meta/_journal.json");

type Booted = {
  readonly origin: string;
  readonly log: () => string;
  readonly stop: () => Promise<void>;
};

const expectedMigration = lastJournalTag();
const workDir = mkdtempSync(join(tmpdir(), "bandar-smoke-"));
const dbPath = join(workDir, "smoke.db");
const created = { id: 0, body: "smoke note" };

let failures = 0;

const first = await boot();
const origin = first.origin;

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
    const health = HealthSchema.parse(await getJson("/api/health", 200));
    assert.equal(health.migration, expectedMigration);
  });

  await check("POST /api/notes creates a note", async () => {
    const note = NoteSchema.parse(await postJson("/api/notes", { body: created.body }, 201));
    assert.equal(note.body, created.body);
    created.id = note.id;
  });

  await check("GET /api/notes lists the created note", async () => {
    const body = await getJson("/api/notes", 200);
    assert.ok(Array.isArray(body));
    assert.ok(
      body.some((note) => note.id === created.id),
      `note ${created.id} is missing from the list`,
    );
  });

  await check("DELETE /api/notes/:id removes the note once", async () => {
    const response = await fetch(new URL(`/api/notes/${created.id}`, origin), { method: "DELETE" });
    assert.equal(response.status, 204);

    const again = await fetch(new URL(`/api/notes/${created.id}`, origin), { method: "DELETE" });
    assert.equal(again.status, 404);
    assert.equal((await errorBody(again)).code, "not_found");
  });

  await check("POST /api/notes with an empty body is a validation error", async () => {
    const response = await post("/api/notes", { body: "" });
    assert.equal(response.status, 422);
    const error = await errorBody(response);
    assert.equal(error.code, "validation");
    assert.ok(error.issues.length > 0, "the validation error carries no issues");
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

    const health = HealthSchema.parse(await getJson("/api/health", 200, second.origin));
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

async function boot(): Promise<Booted> {
  if (!existsSync(BINARY)) throw new Error(`${BINARY} is missing; run \`bun run build\` first`);

  const proc = Bun.spawn([BINARY], {
    env: { ...Bun.env, BANDAR_PORT: "0", BANDAR_DB: dbPath },
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

async function getJson(path: string, status: number, base: string = origin): Promise<unknown> {
  const response = await fetch(new URL(path, base));
  assert.equal(response.status, status);
  return response.json();
}

async function postJson(path: string, body: unknown, status: number): Promise<unknown> {
  const response = await post(path, body);
  assert.equal(response.status, status);
  return response.json();
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(new URL(path, origin), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function errorBody(
  response: Response,
): Promise<{ code: string; message: string; issues: string[] }> {
  return ApiErrorBodySchema.parse(await response.json()).error;
}

function contentType(response: Response): string {
  return response.headers.get("content-type") ?? "";
}

function lastJournalTag(): string {
  const journal = JSON.parse(readFileSync(JOURNAL, "utf8")) as {
    entries: readonly { idx: number; tag: string }[];
  };
  const last = [...journal.entries].sort((a, b) => a.idx - b.idx).at(-1);
  if (!last) throw new Error(`${JOURNAL} has no migration entries`);

  return last.tag;
}
