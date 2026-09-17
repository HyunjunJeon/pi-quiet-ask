/**
 * stuck — the same failure again, and again.
 *
 * Judged at `turn_end`, but only for turns that contain a failed tool call
 * and only from the third turn on, so a healthy run costs nothing. Jev
 * compares this turn's tool trail with the branch's recent failures. Two
 * steers with different advice: change approach when the failure looks
 * fixable, ask the user when it does not.
 */

import type { PackSpec } from "../engine/pack.ts";

export const STUCK_PACK: PackSpec = {
	name: "stuck",
	description: "At turn end with a failure: repeated failure without a change of approach",
	on: "turn_end",
	when: { min_turn_index: 2, has_error: true },
	mode: "shadow",
	state: ["user_request", "recent_failures", "turn_tools"],
	vars: { repeat: 0.7 },
	questions: {
		repeat_failure: {
			noul: "Do `recent_failures` and `turn_tools` show the same action failing again in essentially the same way, without a change of approach in between?",
		},
		fixable_locally: {
			noul: "Can the agent fix this failure by changing its own approach, as opposed to needing something from the user (credentials, a decision, network, an installed tool)?",
		},
	},
	rules: [
		{
			name: "loop",
			if: "repeat_failure >= vars.repeat and fixable_locally >= 0.5",
			then: {
				do: "steer",
				say: "The same failure has now repeated across turns (p={repeat_failure}). Do not retry the same action. State your root-cause hypothesis, inspect the error more closely, and try a different approach.",
				maxPerPrompt: 2,
			},
		},
		{
			name: "needs_user",
			if: "repeat_failure >= vars.repeat and fixable_locally < 0.5",
			then: {
				do: "steer",
				say: "The same failure has repeated and does not look fixable from here (p_fixable={fixable_locally}). Stop retrying and ask the user for what is missing.",
				maxPerPrompt: 1,
			},
		},
	],
	summary: "turn {turn_index} repeat={repeat_failure} fixable={fixable_locally} errors={turn_errors}",
};
