/**
 * Steer wording: the generic (0.2) sentences vs the observed-target
 * sentences. Code decides *that* we steer; Jev only names a member of
 * the ledger. Missing or invented targets fall back to the old text.
 */

import type { ObservedOption } from "./space.ts";

/** Untargeted copy shipped in 0.2.0 — kept as the empty-space fallback. */
export const GENERIC_INVARIANT_STEER: Record<string, string> = {
	report_without_verify:
		"The graph shows code was changed (implement) but no verify phase ran before reporting. Run the relevant test, build, or type check now and include the real result in your report.",
	explore_loop:
		"Exploration has not produced progress for several turns. Commit to a plan from what you already know and start implementing, or ask the user the one question that is blocking you.",
	drift: "Recent turns appear to work on something the user did not ask for. Return to the original request; mention the tangent in one sentence if it matters.",
};

export const GENERIC_HONEST_FINISH =
	"You reported the work as done, but this run shows no verification after the last change (no tests, build, type check, or execution). Run the relevant check now and report the actual result. If it cannot be verified here, say so explicitly instead of claiming completion.";

export const GENERIC_STUCK_LOOP =
	"The same failure has now repeated across turns (p={repeat_failure}). Do not retry the same action. State your root-cause hypothesis, inspect the error more closely, and try a different approach.";

export const GENERIC_STUCK_NEEDS_USER =
	"The same failure has repeated and does not look fixable from here (p_fixable={fixable_locally}). Stop retrying and ask the user for what is missing.";

export function renderInvariantSteer(name: string, target?: ObservedOption): string {
	if (name === "report_without_verify" && target) {
		return `The graph shows code was changed (implement) but no verify phase ran before reporting. Run this observed check now and include the real result: ${target.value}`;
	}
	return GENERIC_INVARIANT_STEER[name] ?? name;
}

export function renderHonestFinishSteer(target?: ObservedOption): string {
	if (!target) return GENERIC_HONEST_FINISH;
	return `You reported the work as done, but this run shows no verification after the last change. Run this observed check now and report the actual result: ${target.value}. If it cannot be verified here, say so explicitly instead of claiming completion.`;
}

export function renderStuckLoopSteer(target?: ObservedOption): string {
	if (!target) return GENERIC_STUCK_LOOP;
	return `The same failure has now repeated across turns (p={repeat_failure}). Do not retry this observed command: ${target.value}. State your root-cause hypothesis, inspect the error more closely, and try a different approach.`;
}

export function renderStuckNeedsUserSteer(target?: ObservedOption): string {
	if (!target) return GENERIC_STUCK_NEEDS_USER;
	return `The same failure has repeated and does not look fixable from here (p_fixable={fixable_locally}). Stop retrying ${target.value} and ask the user for what is missing.`;
}
