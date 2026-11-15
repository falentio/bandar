import { imagesOf } from "../../shared/conversation";
import type { InputModality } from "../../shared/providers";
import type { CanonicalRequest } from "../providers/types";
import type { ResolvedAttempt, ResolvedPlan } from "./resolve";

/** The input a request cannot be answered without: text always, an image when one is carried. */
export function requiredModalities(request: CanonicalRequest): readonly InputModality[] {
  const images = request.messages.some((message) => imagesOf(message.content).length > 0);

  return images ? ["text", "image"] : ["text"];
}

export type GatedPlan = {
  readonly attempts: readonly ResolvedAttempt[];
  readonly refused: readonly ResolvedAttempt[];
};

/**
 * Splits a plan by what each model says it can read, before anything is attempted. Null modalities
 * mean the catalog is silent, which is unknown rather than text-only, so such a model may try.
 */
export function planFor(plan: ResolvedPlan, needed: readonly InputModality[]): GatedPlan {
  const attempts: ResolvedAttempt[] = [];
  const refused: ResolvedAttempt[] = [];

  for (const attempt of plan.attempts) {
    if (readsAll(attempt.inputModalities, needed)) attempts.push(attempt);
    else refused.push(attempt);
  }

  return { attempts, refused };
}

/** What the refusal says: the reference, and what its models read instead. */
export function refusalOf(
  reference: string,
  refused: readonly ResolvedAttempt[],
  needed: readonly InputModality[],
): string {
  const reads = [...new Set(refused.map((attempt) => spokenOf(attempt)))].join(", ");

  return `${reference} cannot carry this request: it needs ${needed.join(" and ")}, and ${reads}`;
}

function readsAll(
  available: readonly InputModality[] | null,
  needed: readonly InputModality[],
): boolean {
  if (available === null) return true;

  return needed.every((modality) => available.includes(modality));
}

function spokenOf(attempt: ResolvedAttempt): string {
  const available = attempt.inputModalities;

  return available === null
    ? `${attempt.slug} reads whatever the catalog does not say`
    : `${attempt.slug} reads ${available.join(" and ")}`;
}
