import * as v from "valibot";

export const TAG_REF_PREFIX = "tags/";

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const MAX_SLUG_LENGTH = 40;
const MAX_GENERATED_LENGTH = 36;

export const SlugSchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(MAX_SLUG_LENGTH),
  v.regex(SLUG_PATTERN, "use lowercase letters, digits, and single hyphens"),
);

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, MAX_GENERATED_LENGTH)
    .replace(/^-+|-+$/g, "");
}

export function availableSlug(base: string, taken: ReadonlySet<string>): string {
  const root = base === "" ? "provider" : base;

  if (!taken.has(root)) return root;

  for (let suffix = 2; ; suffix += 1) {
    const tail = `-${String(suffix)}`;
    const head = root.slice(0, MAX_SLUG_LENGTH - tail.length).replace(/-+$/, "");
    const candidate = `${head === "" ? "provider" : head}${tail}`;

    if (!taken.has(candidate)) return candidate;
  }
}

export function providerRefOf(providerSlug: string, upstreamModel: string): string {
  return `${providerSlug}/${upstreamModel}`;
}

export function tagRefOf(slug: string): string {
  return `${TAG_REF_PREFIX}${slug}`;
}
