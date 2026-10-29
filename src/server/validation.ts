import * as v from "valibot";

export type ParseableInput =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly ParseableInput[]
  | { readonly [key: string]: ParseableInput };

export type IssueText = {
  readonly param: string | null;
  readonly message: string;
};

export class InputError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`invalid input:\n${issues.map((issue) => `  ${issue}`).join("\n")}`);
    this.name = "InputError";
    this.issues = issues;
  }
}

export function issueText(issue: v.BaseIssue<unknown>): IssueText {
  const param = issueParam(issue);

  return { param, message: param === null ? issue.message : `${param}: ${issue.message}` };
}

/** The first issue of a failed parse, rendered for the caller. */
export function issueOf(
  issues: readonly [v.BaseIssue<unknown>, ...v.BaseIssue<unknown>[]],
): IssueText {
  return issueText(issues[0]);
}

function issueParam(issue: v.BaseIssue<unknown>): string | null {
  const path = issue.path?.map((item) => String(item.key)).join(".");

  return path === undefined || path === "" ? null : path;
}

export function parseInput<
  const TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
>(schema: TSchema, value: ParseableInput): v.InferOutput<TSchema> {
  const parsed = v.safeParse(schema, value);

  if (parsed.success) return parsed.output;

  throw new InputError(parsed.issues.map((issue) => issueText(issue).message));
}
