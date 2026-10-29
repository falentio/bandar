import * as v from "valibot";

export const SESSION_ID_HEADER = "x-bandar-session-id";

export const MAX_SESSION_ID_LENGTH = 128;

export function sessionIdOf(value: string | null): string | null {
  const raw = value?.trim() ?? "";

  if (raw === "" || raw.length > MAX_SESSION_ID_LENGTH) return null;

  for (const character of raw) {
    const code = character.codePointAt(0) ?? 0;

    if (code < 0x21 || code > 0x7e) return null;
  }

  return raw;
}

export const SessionIdSchema = v.pipe(
  v.string(),
  v.check(
    (value) => sessionIdOf(value) !== null,
    "use 1-128 printable ascii characters with no space inside. Leading and trailing spaces are dropped.",
  ),
);
