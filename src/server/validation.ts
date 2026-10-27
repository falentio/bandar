import * as v from "valibot";

export type ParseableInput =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly ParseableInput[]
  | { readonly [key: string]: ParseableInput };

export class InputError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`invalid input:\n${issues.map((issue) => `  ${issue}`).join("\n")}`);
    this.name = "InputError";
    this.issues = issues;
  }
}

export function parseInput<
  const TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
>(schema: TSchema, value: ParseableInput): v.InferOutput<TSchema> {
  const parsed = v.safeParse(schema, value);

  if (parsed.success) return parsed.output;

  throw new InputError(
    parsed.issues.map((issue) => {
      const path = issue.path?.map((item) => String(item.key)).join(".") ?? "";

      return path === "" ? issue.message : `${path}: ${issue.message}`;
    }),
  );
}
