import * as v from "valibot";

export const PROJECT_URL_HEADER = "x-bandar-project-url";

export const MAX_PROJECT_URL_LENGTH = 2048;

export function projectUrlOf(value: string | null): string | null {
  const raw = value?.trim() ?? "";

  if (raw === "" || raw.length > MAX_PROJECT_URL_LENGTH) return null;

  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const project = url.origin + url.pathname.replace(/\/+$/, "");

  return project.length > MAX_PROJECT_URL_LENGTH ? null : project;
}

export type GithubRepo = { readonly owner: string; readonly repo: string };

export function githubRepoOf(value: string): GithubRepo | null {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.hostname !== "github.com") return null;

  const segments = url.pathname.split("/").filter((segment) => segment !== "");

  if (segments.length !== 2) return null;

  const [owner, name] = segments;

  if (owner === undefined || name === undefined) return null;

  const repo = name.endsWith(".git") ? name.slice(0, -4) : name;

  if (repo === "") return null;

  return { owner, repo };
}

export const ProjectUrlSchema = v.pipe(
  v.string(),
  v.check((value) => projectUrlOf(value) !== null, "use a full http or https url"),
);
