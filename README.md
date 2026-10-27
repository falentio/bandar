# bandar

One executable. It carries a React client, an Elysia API on Bun, and the SQLite
migrations that shape its database. You build it once, copy it anywhere, and run
it; it creates its SQLite file beside itself and serves the whole app on one port.
No `node_modules`, no `dist/`, no migration folder beside the binary.

The app in the box is a notes demo: email + password sign-up, three notes
routes, and one screen. It exists to prove every layer (browser → API → Drizzle
→ SQLite file → back, with a session cookie in the middle) in code you can read
in one sitting.

## Run it

```sh
bun install          # also generates src/server/generated/*
bun run dev          # http://127.0.0.1:5173, API proxied to :3000
```

The dev server binds every interface (`host: true`) and accepts Tailscale
MagicDNS hostnames, so another device on the tailnet opens the same page at
`http://<machine>.<tailnet>.ts.net:5173`; HMR runs over that name too. Vite's
host check is still on: an unknown `Host` is a 403. A custom tailnet domain goes
next to `.ts.net` in `server.allowedHosts` in `./vite.config.ts`.

The compiled artifact:

```sh
bun run build        # dist/bandar, ~92 MB
BANDAR_AUTH_SECRET=$(openssl rand -hex 32) ./dist/bandar   # http://0.0.0.0:3000
```

Without `BANDAR_AUTH_SECRET` the binary generates one per boot: it warns, and
every session ends when the process restarts.

## Commands

| Script                   | What it runs                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `bun run dev`            | `gen`, then `vp dev` (HMR client) and `bun --watch src/server/main.ts` in parallel |
| `bun run dev:web`        | `vp dev` alone, on `DEFAULT_WEB_PORT`                                              |
| `bun run dev:server`     | `gen`, then the API with `bun --watch` on `DEFAULT_API_PORT`                       |
| `bun run gen`            | `bun scripts/gen.ts` — write the two generated modules                             |
| `bun run build:client`   | `vp build` → `dist/client`                                                         |
| `bun run compile`        | `gen --strict`, then `bun build --compile` → `dist/bandar`                         |
| `bun run build`          | `build:client`, then `compile`                                                     |
| `bun run start`          | `./dist/bandar`                                                                    |
| `bun run check`          | `gen`, then `vp check` (oxfmt + oxlint + tsgolint)                                 |
| `bun run check:fix`      | same with `--fix`                                                                  |
| `bun run test`           | `gen`, then `bun --bun vp test run`                                                |
| `bun run smoke`          | boot `dist/bandar` on an ephemeral port and assert the whole loop                  |
| `bun run verify`         | `check`, `test`, `build`, `smoke` in order                                         |
| `bun run db:generate`    | `drizzle-kit generate` → `drizzle/000N_<name>.sql`                                 |
| `bun run db:auth-schema` | `@better-auth/cli generate` → `src/server/db/auth-schema.ts`                       |
| `postinstall`            | `gen`, so a fresh clone type-checks before its first build                         |

`test` runs `bun --bun vp test run`, not plain `vp test run`: vitest's Node workers
cannot resolve `bun:sqlite`, and the idempotency test deliberately uses it.

## Lint policy

`vp check` runs oxfmt, oxlint and tsgolint, plus the vendored
[anti-slop](https://github.com/dmmulroy/anti-slop) rules in
`./tools/oxlint/anti-slop/`. Upstream publishes no npm package on purpose: the
rules are meant to be copied in and edited. This copy is MIT-licensed, from
commit `13909c9`, and registered in the `lint` block of `./vite.config.ts`.

Every generic rule is enabled as an error: the array-method and reducer-shape
rules, `no-chained-type-assertions`, `no-known-value-widening`,
`no-object-parameters`, the `unknown` family (`no-unknown-parameters`,
`no-unknown-returns`, `no-unknown-type-aliases`, `no-unsafe-dictionary-type`,
`no-widen-then-assert`), `no-runtime-typeof`, `no-module-mocking`,
`no-shape-in-symbol-names`, `require-readable-spacing`,
`require-safety-comment-for-type-assertion`, and `oxc/no-accumulating-spread`.

The Effect rule group stays out; this project does not use Effect. A type
assertion needs a `// SAFETY:` line stating the invariant the assertion relies
on, and a value of unknown type gets narrowed by an `instanceof` or a type
predicate before any helper sees it, not passed along as `unknown`.

The vendored files are local policy: change a rule here when it disagrees with
the project. `@oxlint/plugins` is pinned to the exact `oxlint` version
`vite-plus` resolves (1.89.0); bump both together or the plugin stops loading.
`tools/oxlint/anti-slop/**` is ignored by lint and format so the vendored code
stays as upstream wrote it.

## Environment

| Variable                 | Default                                       | Meaning                                                               |
| ------------------------ | --------------------------------------------- | --------------------------------------------------------------------- |
| `BANDAR_HOST`            | `0.0.0.0`                                     | Bind address. The default is reachable on loopback, LAN, and tailnet. |
| `BANDAR_PORT`            | `3000`                                        | Listen port. `0` picks a free port and the boot line reports it.      |
| `BANDAR_DB`              | `./bandar.db`                                 | SQLite file path. Created on first boot, WAL mode.                    |
| `BANDAR_AUTH_URL`        | `http://localhost:<port>`                     | Origin better-auth uses as its base URL.                              |
| `BANDAR_AUTH_SECRET`     | random per boot                               | Signs session cookies. Set it to keep sessions across restarts.       |
| `BANDAR_TRUSTED_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Comma-separated origins allowed to POST to `/api/auth/*`.             |

Invalid values fail at startup with every offending variable listed, before the
port is bound.

## Layout

```
bandar/
├── index.html                    # mounts /src/client/main.tsx at #root
├── vite.config.ts                # Vite, aliases, dev proxy, oxlint/oxfmt config
├── drizzle.config.ts             # drizzle-kit: schema in TS, SQL out
├── drizzle/                      # generated SQL + journal, committed
├── public/favicon.svg            # copied from assets/icon.svg
├── scripts/
│   ├── gen.ts                    # client + migration embedding generator
│   ├── auth-schema.config.ts     # config only `db:auth-schema` reads (no bun:sqlite)
│   └── smoke.ts                  # end-to-end check of dist/bandar
├── src/shared/                   # valibot only, imported by both sides
│   ├── notes.ts                  # note + note input schemas, NOTE_BODY_MAX
│   ├── auth.ts                   # auth paths, sign-up/sign-in, session schemas
│   ├── api-keys.ts               # key paths, header name, key schemas
│   ├── api.ts                    # api paths, isApiPath, error envelope, health
│   └── topology.ts               # dev ports
├── src/server/
│   ├── main.ts                   # config → db → migrations → auth → bundle → serve
│   ├── app.ts                    # App.handle: /api to Elysia, everything else to static
│   ├── api.ts                    # Elysia routes, session gate, error envelope
│   ├── auth.ts                   # better-auth handler + getSession seam
│   ├── validation.ts             # parseInput, InputError, issue formatting
│   ├── assets.ts                 # ClientBundle + serveStatic (MIME, cache, SPA fallback)
│   ├── config.ts                 # BANDAR_* parsing, ConfigError
│   ├── notes.ts                  # NotesRepo, scoped by user id
│   ├── embedded.d.ts             # types for *.embed and *.sql imports
│   ├── db/
│   │   ├── schema.ts             # drizzle tables
│   │   ├── auth-schema.ts        # generated; user, session, account, verification, apikey
│   │   ├── client.ts             # bun:sqlite + drizzle, pragmas
│   │   ├── migrate.ts            # embedded SQL, journaled ledger, drift/downgrade refusal
│   │   └── migrate.test.ts       # idempotency, rollback, drift, downgrade
│   └── generated/                # gitignored; written by scripts/gen.ts
├── src/client/
│   ├── main.tsx                  # createRoot
│   ├── app.tsx                   # session gate, then notes
│   ├── api.ts                    # fetch + valibot parse + ApiError
│   ├── use-session.ts            # SessionState machine + auth actions
│   ├── use-notes.ts              # NotesState machine, one pending flag
│   ├── use-api-keys.ts           # ApiKeysState machine, create/revoke
│   ├── components/notes-panel.tsx
│   ├── components/api-keys-panel.tsx # mint, show once, revoke
│   ├── components/auth-panel.tsx # sign-in / create-account card
│   └── index.css                 # tailwind + shadcn tokens
├── src/components/ui/            # shadcn primitives, untouched
├── src/lib/utils.ts              # re-exports cn
└── tools/oxlint/anti-slop/       # vendored anti-slop rules (MIT)
```

Two tsconfig projects split the type surface: `tsconfig.app.json` has DOM and no
Bun types, `tsconfig.server.json` has Bun and no DOM. A Drizzle table imported
from a client file fails `vp check` rather than shipping in the bundle.

## How a request flows

```
Request
├── path starts with /api
│   ├── /api/auth/*
│   │   └── src/server/auth.ts     # better-auth handler, cookies untouched
│   └── any other /api route
│       └── src/server/api.ts      # session gate, valibot parse, error envelope
│           └── src/server/notes.ts    # NotesRepo, scoped by user id
│               └── src/server/db/client.ts + schema.ts   # Drizzle → bun:sqlite
└── any other path
    └── src/server/assets.ts       # exact file, /assets/ miss → 404,
                                   # extensionless miss → /index.html, else 404
```

The SQLite file, the client assets, and the migrations are all inside the binary;
the only thing on disk at runtime is the database.

## Auth

`src/server/auth.ts` builds better-auth/minimal with the Drizzle adapter over the
same `bun:sqlite` handle, and `src/server/api.ts` mounts the whole handler at
`/api/auth/*`, before any notes route. Email and password is on; better-auth owns
the session cookie, and no other module reads the token.

Notes belong to the session user. `notes.user_id` is a `NOT NULL` foreign key to
`user.id` with `ON DELETE cascade`, and every `/api/notes` route answers 401
`{ error: { code: "unauthorized", ... } }` without a session. The pre-auth notes
are not migrated: migration 0001 rebuilds `notes` with the new column and drops
the old rows.

better-auth rejects a POST whose `Origin` is neither `BANDAR_AUTH_URL` nor an
entry in `BANDAR_TRUSTED_ORIGINS`, answering 403 `{"code":"INVALID_ORIGIN"}`.
The dev browser posts from `http://localhost:5173` (or
`http://127.0.0.1:5173`), which the defaults trust. On the tailnet, add the Vite
origin, for example `BANDAR_TRUSTED_ORIGINS=http://localhost:5173,http://box.tailnet.ts.net:5173`.
A script posting to `/api/auth/*` must send a matching `Origin` header too.

`BANDAR_AUTH_SECRET` signs session cookies. When unset, `parseConfig` generates
32 random bytes per boot and warns once; restarting the process logs everyone
out. Set a fixed 32-byte hex value wherever sessions must outlive a restart.

`src/server/db/auth-schema.ts` comes from `bun run db:auth-schema`, which runs the
CLI against `scripts/auth-schema.config.ts`. That config exists only for the CLI:
it runs under Node, which cannot import `bun:sqlite`, so the config builds the
adapter over a stub `drizzle-orm/sqlite-proxy` client. After changing auth
options, rerun the script and then `bun run db:generate --name <change>` for the
table diff. Never edit the generated file by hand.

### API keys

`@better-auth/api-key` lets a signed-in user mint keys for scripts and send them
as `x-api-key` on `/api/notes`. A key is `bandar_` plus 64 random characters. The
plaintext is returned once; the `apikey` row stores the hash and the first 11
characters as `start`, which is all the list shows.

- `POST /api/auth/api-key/create` with `{ "name": "laptop" }` → the plaintext key.
- `GET /api/auth/api-key/list` → the caller's keys, never the plaintext.
- `POST /api/auth/api-key/delete` with `{ "keyId": "..." }` → `{ "success": true }`.

The signed-in screen makes the same three calls in an API keys card below the
notes, and shows the plaintext once with a Dismiss button. A request carrying
`x-api-key` is gated by the key alone: an unknown or revoked key answers 401
`{ "error": { "code": "unauthorized", ... } }`, and the cookie is not consulted.
Every key is rate limited to 1000 requests per hour.

`enableSessionForAPIKeys` stays off. With it on, a key would also satisfy the
session guard on `/api/auth/*`, so a leaked key could mint more keys.

The plugin's `apikey` table lives in `src/server/db/auth-schema.ts` (regeneration
keeps it because `scripts/auth-schema.config.ts` lists the plugin) and ships in
`drizzle/0002_api_keys.sql`. It has no foreign key: `reference_id` holds the user
id.

## Adding an entity

Rename or add around these files, in this order. Nothing else knows about notes.

1. `src/server/db/schema.ts` — add the `sqliteTable`, export its row type.
2. `bun run db:generate --name <entity>` — writes `drizzle/000N_<entity>.sql`
   and updates `drizzle/meta/_journal.json`. Both are inputs; commit them.
3. `src/shared/<entity>.ts` — the wire schemas (`Input`, item, list, id). valibot only,
   no Drizzle or Bun imports.
4. `src/server/<entity>.ts` — a repo with `list`, `create`, `remove`; the shared
   db is passed in from `src/server/app.ts`.
5. `src/server/api.ts` — mount the routes under the `/api` prefix.
6. `src/server/app.ts` — build the repo from `deps.db` and pass it to `createApi`.
7. `src/client/api.ts` — one function per route, each parsing with the shared schema.
8. `src/client/use-<entity>.ts` — the state machine, following `use-notes.ts`.
9. `src/client/components/<entity>-panel.tsx` — the screen; mount it in `app.tsx`.

Then `bun run check && bun run test && bun run smoke`. `scripts/smoke.ts` is the
one place that asserts the new routes end to end; add a check per new route.

## Deleting the demo slice

The scaffold stays useful with the notes demo gone. Delete, in this order:

1. Auth: `src/client/components/auth-panel.tsx`, `src/client/use-session.ts`,
   and the session gate in `src/client/app.tsx`; `src/shared/auth.ts` and
   `authApi` in `src/client/api.ts`; `src/server/auth.ts`, the `/auth/*` route,
   and `authenticate` in `src/server/api.ts`. The API keys card goes with it:
   `src/client/components/api-keys-panel.tsx`, `src/client/use-api-keys.ts`,
   `src/shared/api-keys.ts`, and `apiKeyApi` in `src/client/api.ts`.
2. `src/server/db/auth-schema.ts` (the `user`, `session`, `account`,
   `verification`, and `apikey` tables), `scripts/auth-schema.config.ts`, and the
   `db:auth-schema` script.
3. `src/client/components/notes-panel.tsx`, `src/client/use-notes.ts` — and the
   `<NotesPanel />` in `src/client/app.tsx`.
4. `src/shared/notes.ts`, and the notes calls and `ApiError` usage in
   `src/client/api.ts` (keep `request`, `send`, and `ApiError`).
5. `src/server/notes.ts`, and its routes in `src/server/api.ts`.
6. The `notes` table in `src/server/db/schema.ts`.
7. `src/server/db/migrate.test.ts` — or keep it, it tests the migrator, not notes.

Then write a migration that drops the tables (`bun run db:generate --name
drop-demo` after editing the schema) instead of editing `drizzle/0000_init.sql`;
`migrate.ts` refuses a changed body for an applied tag. `scripts/smoke.ts` and
`src/server/app.ts` keep working with no repos mounted.

Deleting auth alone means dropping the five tables (`account`, `session`, `user`,
`verification`, `apikey`), removing `notes.user_id`, and removing the session
gate. Drop the session gate first, remove `userId` from the notes table, delete
the auth tables from the schema, then run `bun run db:generate --name drop-auth`.
The `user` rows go with the table; notes keep their bodies once `user_id` is gone.

## Generated files

`src/server/generated/migrations.ts` and `src/server/generated/client-assets.ts`
are written by `scripts/gen.ts` and gitignored — hashed client filenames change on
every build, so committing them only produces conflicts.

- `gen` reads `drizzle/meta/_journal.json`, imports each `drizzle/<tag>.sql` as
  text, and stages every file under `dist/client` into `.build/embed/<rel>.embed`
  before importing it with `type: "file"`.
- The `.embed` suffix is required: Bun treats an imported `.html` with
  `type: "file"` as an HTML entrypoint and hands back an `HTMLBundle`, not a path.
- With no `dist/client`, `gen` warns and emits an empty bundle, so a fresh clone
  still type-checks. `gen --strict`, which `compile` uses, throws instead.
- `gen` writes only when the rendered text changes, so it is safe to rerun.

`bun --watch src/server/main.ts` restarts when `gen` rewrites the generated
modules, which happens after a client build. That restart is expected.

## Migrations

`applyMigrations` runs on every boot, before the port opens, over the SQL embedded
at compile time:

- The ledger is `_bandar_migrations(tag, checksum, applied_at)`; the checksum is
  `Bun.hash.crc32(sql)` computed at boot, not baked in.
- A ledger tag the binary does not embed → `MigrationDowngradeError`.
- An applied tag whose checksum differs → `MigrationDriftError`.
- Each pending migration runs inside `BEGIN IMMEDIATE`, writes its ledger row, then
  commits; a throw rolls the whole migration back, so a crash leaves no partial DDL.

Consequence: fix a shipped migration by adding the next one, never by editing it.
`GET /api/health` reports the current tag, which is how `smoke` knows the second
boot applied nothing.

## Static serving

MIME comes from the request path (`CONTENT_TYPES` in `src/server/assets.ts`), not
from the embedded file: the staged copy ends in `.embed`, so `Bun.file().type`
would be useless. `/assets/*` is immutable for a year; everything else is
`no-cache`. A `HEAD` returns the same headers with no body. With no client bundle
embedded, every page request is a 503 naming `bun run build`.
