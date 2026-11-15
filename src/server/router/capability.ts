import { imagesOf } from "../../shared/conversation";
import type { InputModality } from "../../shared/providers";
import type { CanonicalRequest } from "../providers/types";
import type { ResolvedAttempt, ResolvedPlan } from "./resolve";

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

/** Only a model the catalog labelled can be refused, so its modalities are known here. */
function spokenOf(attempt: ResolvedAttempt): string {
  return `${attempt.slug} reads ${(attempt.inputModalities ?? []).join(" and ")}`;
}
