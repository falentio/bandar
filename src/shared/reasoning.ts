import * as v from "valibot";

/** The widest ladder any wire offers; each adapter keeps the rungs its own wire serves. */
export const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/**
 * One client intent at a time: a level, or a token allowance. The wires disagree about which
 * they accept, so an adapter drops the kind its wire cannot spell rather than inventing one.
 */
export type Reasoning =
  | { readonly kind: "effort"; readonly effort: ReasoningEffort }
  | { readonly kind: "budget"; readonly budgetTokens: number };

export const ReasoningEffortSchema: v.GenericSchema<ReasoningEffort> =
  v.picklist(REASONING_EFFORTS);
