import { eq } from "drizzle-orm";
import type { ProviderKind } from "../../shared/providers";
import { availableSlug, slugify } from "../../shared/slugs";
import type { Db } from "../db/client";
import { providers } from "../db/schema";
import { builtInProviders, definitionFor, reservedProviderSlugs } from "./registry";

/** Gives every account a row for each built-in kind it is missing. */
export async function ensureBuiltInProviders(db: Db, userId: string): Promise<void> {
  const rows = await db
    .select({
      kind: providers.kind,
      name: providers.name,
      origin: providers.origin,
      slug: providers.slug,
    })
    .from(providers)
    .where(eq(providers.userId, userId));

  const present = new Set(rows.filter((row) => row.origin === "builtin").map((row) => row.kind));
  const names = new Set(rows.map((row) => row.name));
  const slugs = new Set(rows.flatMap((row) => (row.slug === "" ? [] : [row.slug])));
  const now = new Date();

  for (const definition of builtInProviders) {
    if (present.has(definition.kind)) continue;

    // A custom row can already hold a slug that has since become reserved.
    const name = availableName(definition.builtIn.name, names);
    const slug = availableSlug(definition.builtIn.slug, slugs);

    names.add(name);
    slugs.add(slug);

    db.insert(providers)
      .values({
        id: crypto.randomUUID(),
        userId,
        name,
        slug,
        kind: definition.kind,
        baseUrl: definition.builtIn.baseUrl(),
        origin: "builtin",
        createdAt: now,
      })
      .onConflictDoNothing()
      .run();
  }
}

/** Fills the slug of every provider written before slugs existed. */
export async function assignProviderSlugs(db: Db): Promise<number> {
  const rows = await db
    .select({
      id: providers.id,
      userId: providers.userId,
      name: providers.name,
      kind: providers.kind,
      origin: providers.origin,
      slug: providers.slug,
      createdAt: providers.createdAt,
    })
    .from(providers);

  const byUser = new Map<string, typeof rows>();

  for (const row of rows) {
    byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row]);
  }

  let assigned = 0;

  for (const userRows of byUser.values()) {
    const taken = new Set(reservedProviderSlugs);

    for (const row of userRows) {
      if (row.slug !== "") taken.add(row.slug);
    }

    const pending = userRows
      .filter((row) => row.slug === "")
      .sort((left, right) => {
        const leftRank = left.origin === "builtin" ? 0 : 1;
        const rightRank = right.origin === "builtin" ? 0 : 1;

        if (leftRank !== rightRank) return leftRank - rightRank;

        const created = left.createdAt.getTime() - right.createdAt.getTime();

        return created !== 0 ? created : left.id.localeCompare(right.id);
      });

    if (pending.length === 0) continue;

    db.transaction((tx) => {
      for (const row of pending) {
        const builtIn = builtInSlugOf(row.kind);
        const slug = builtIn ?? availableSlug(slugify(row.name), taken);

        tx.update(providers).set({ slug }).where(eq(providers.id, row.id)).run();
        taken.add(slug);
        assigned += 1;
      }
    });
  }

  return assigned;
}

function builtInSlugOf(kind: ProviderKind): string | null {
  return definitionFor(kind).builtIn?.slug ?? null;
}

function availableName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;

  let suffix = 2;

  while (taken.has(`${base} ${suffix}`)) suffix += 1;

  return `${base} ${suffix}`;
}
