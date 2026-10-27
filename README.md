# bandar

One executable. It carries a React client, an Elysia API on Bun, and the SQLite
migrations that shape its database. You build it once, copy it anywhere, and run
it; it creates its SQLite file beside itself and serves the whole app on one port.
No `node_modules`, no `dist/`, no migration folder beside the binary.

The app in the box is a notes demo: three API routes and one screen. It exists to
prove every layer (browser → API → Drizzle → SQLite file → back) in code you can
read in one sitting.

## Run it

```sh
bun install          # also generates src/server/generated/*
bun run dev          # http://127.0.0.1:5173, API proxied to :3000
```

The compiled artifact:

```sh
bun run build        # dist/bandar, ~92 MB
./dist/bandar        # http://0.0.0.0:3000
```

## Commands

| Script                 | What it runs                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------- |
| `bun run dev`          | `gen`, then `vp dev` (HMR client) and `bun --watch src/server/main.ts` in parallel |
| `bun run dev:web`      | `vp dev` alone, on `DEFAULT_WEB_PORT`                                              |
| `bun run dev:server`   | `gen`, then the API with `bun --watch` on `DEFAULT_API_PORT`                       |
| `bun run gen`          | `bun scripts/gen.ts` — write the two generated modules                             |
| `bun run build:client` | `vp build` → `dist/client`                                                         |
| `bun run compile`      | `gen --strict`, then `bun build --compile` → `dist/bandar`                         |
| `bun run build`        | `build:client`, then `compile`                                                     |
| `bun run start`        | `./dist/bandar`                                                                    |
| `bun run check`        | `gen`, then `vp check` (oxfmt + oxlint + tsgolint)                                 |
| `bun run check:fix`    | same with `--fix`                                                                  |
| `bun run test`         | `gen`, then `bun --bun vp test run`                                                |
| `bun run smoke`        | boot `dist/bandar` on an ephemeral port and assert the whole loop                  |
| `bun run verify`       | `check`, `test`, `build`, `smoke` in order                                         |
| `bun run db:generate`  | `drizzle-kit generate` → `drizzle/0000_<name>.sql`                                 |
| `postinstall`          | `gen`, so a fresh clone type-checks before its first build                         |

`test` runs `bun --bun vp test run`, not plain `vp test run`: vitest's Node workers
cannot resolve `bun:sqlite`, and the idempotency test deliberately uses it.

## Environment

| Variable      | Default       | Meaning                                                               |
| ------------- | ------------- | --------------------------------------------------------------------- |
| `BANDAR_HOST` | `0.0.0.0`     | Bind address. The default is reachable on loopback, LAN, and tailnet. |
| `BANDAR_PORT` | `3000`        | Listen port. `0` picks a free port and the boot line reports it.      |
| `BANDAR_DB`   | `./bandar.db` | SQLite file path. Created on first boot, WAL mode.                    |

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
│   └── smoke.ts                  # end-to-end check of dist/bandar
├── src/shared/                   # zod only, imported by both sides
│   ├── notes.ts                  # note + note input schemas, NOTE_BODY_MAX
│   ├── api.ts                    # api paths, isApiPath, error envelope, health
│   └── topology.ts               # dev ports
├── src/server/
│   ├── main.ts                   # config → db → migrations → bundle → app → serve
│   ├── app.ts                    # App.handle: /api to Elysia, everything else to static
│   ├── api.ts                    # Elysia routes and the error envelope
│   ├── assets.ts                 # ClientBundle + serveStatic (MIME, cache, SPA fallback)
│   ├── config.ts                 # BANDAR_* parsing, ConfigError
│   ├── notes.ts                  # NotesRepo: the storage seam
│   ├── embedded.d.ts             # types for *.embed and *.sql imports
│   ├── db/
│   │   ├── schema.ts             # drizzle tables
│   │   ├── client.ts             # bun:sqlite + drizzle, pragmas
│   │   ├── migrate.ts            # embedded SQL, journaled ledger, drift/downgrade refusal
│   │   └── migrate.test.ts       # idempotency, rollback, drift, downgrade
│   └── generated/                # gitignored; written by scripts/gen.ts
├── src/client/
│   ├── main.tsx                  # createRoot
│   ├── app.tsx                   # page shell
│   ├── api.ts                    # fetch + zod parse + ApiError
│   ├── use-notes.ts              # NotesState machine, one pending flag
│   ├── components/notes-panel.tsx
│   └── index.css                 # tailwind + shadcn tokens
├── src/components/ui/            # shadcn primitives, untouched
└── src/lib/utils.ts              # re-exports cn
```

Two tsconfig projects split the type surface: `tsconfig.app.json` has DOM and no
Bun types, `tsconfig.server.json` has Bun and no DOM. A Drizzle table imported
from a client file fails `vp check` rather than shipping in the bundle.

## How a request flows

```
Request
├── path starts with /api
│   └── src/server/api.ts          # Elysia route, body/params validated by zod
│       └── src/server/notes.ts    # NotesRepo
│           └── src/server/db/client.ts + schema.ts   # Drizzle → bun:sqlite
└── any other path
    └── src/server/assets.ts       # exact file, /assets/ miss → 404,
                                   # extensionless miss → /index.html, else 404
```

The SQLite file, the client assets, and the migrations are all inside the binary;
the only thing on disk at runtime is the database.

## Adding an entity

Rename or add around these files, in this order. Nothing else knows about notes.

1. `src/server/db/schema.ts` — add the `sqliteTable`, export its row type.
2. `bun run db:generate --name <entity>` — writes `drizzle/000N_<entity>.sql`
   and updates `drizzle/meta/_journal.json`. Both are inputs; commit them.
3. `src/shared/<entity>.ts` — the wire schemas (`Input`, item, list, id). zod only,
   no Drizzle or Bun imports.
4. `src/server/<entity>.ts` — a repo with `list`, `create`, `remove`; the shared
   db and migration result are passed in from `src/server/app.ts`.
5. `src/server/api.ts` — mount the routes under the `/api` prefix.
6. `src/server/app.ts` — build the repo from `deps.db` and pass it to `createApi`.
7. `src/client/api.ts` — one function per route, each parsing with the shared schema.
8. `src/client/use-<entity>.ts` — the state machine, following `use-notes.ts`.
9. `src/client/components/<entity>-panel.tsx` — the screen; mount it in `app.tsx`.

Then `bun run check && bun run test && bun run smoke`. `scripts/smoke.ts` is the
one place that asserts the new routes end to end; add a check per new route.

## Deleting the demo slice

The scaffold stays useful with the notes demo gone. Delete, in this order:

1. `src/client/components/notes-panel.tsx`, `src/client/use-notes.ts` — and the
   `<NotesPanel />` in `src/client/app.tsx`.
2. `src/shared/notes.ts`, and the notes calls and `ApiError` usage in
   `src/client/api.ts` (keep `request`, `send`, and `ApiError`).
3. `src/server/notes.ts`, and its routes in `src/server/api.ts`.
4. The `notes` table in `src/server/db/schema.ts`.
5. `src/server/db/migrate.test.ts` — or keep it, it tests the migrator, not notes.

Then write a migration that drops the table (`bun run db:generate --name
drop-notes` after editing the schema) instead of editing `drizzle/0000_init.sql`;
`migrate.ts` refuses a changed body for an applied tag. `scripts/smoke.ts` and
`src/server/app.ts` keep working with no repos mounted.

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
