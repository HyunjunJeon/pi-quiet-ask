/**
 * intent — classify the user's prompt before the agent starts.
 *
 * The classification is recorded and shown in the footer on every prompt;
 * that alone lets a user audit "what did the harness think I asked for".
 * In enforce mode the two routing rules move the thinking level: deep for
 * debugging and features, light for plain questions. Anything else keeps
 * whatever the user set.
 */

import type { PackSpec } from "../engine/pack.ts";

export const INTENT_PACK: PackSpec = {
	name: "intent",
	description: "Before each run: what kind of task is this; route thinking level in enforce mode",
	on: "before_agent_start",
	mode: "shadow",
	state: ["prompt", "recent_turns"],
	vars: { min_confidence: 0.55, ambiguous: 0.75 },
	questions: {
		intent: {
			choice: "What is the user asking the coding agent to do in `prompt`?",
			options: {
				question: "answer a question or explain something; no code change expected",
				small_edit: "a small, well-specified change to existing code or config",
				feature: "build or extend functionality, likely touching more than one place",
				debug: "find and fix a reported failure, bug, or wrong behaviour",
				refactor: "restructure or clean up code without changing behaviour",
				explore: "investigate, survey, or summarise the codebase; no change yet",
				chore: "dependency, formatting, tooling, or housekeeping work",
				other: null,
			},
		},
		ambiguous: { noul: "Is `prompt` too ambiguous to act on without first asking the user something?" },
	},
	rules: [
		{ name: "classify", if: "intent.confidence >= vars.min_confidence", then: { do: "tag", label: "{intent}" } },
		{ name: "ambiguous", if: "ambiguous >= vars.ambiguous", then: { do: "warn", say: "prompt looks ambiguous (p={ambiguous}); a clarifying question is likely" } },
		{
			name: "think_hard",
			if: '(intent == "debug" or intent == "feature") and intent.confidence >= vars.min_confidence',
			then: { do: "set_thinking", level: "high" },
		},
		{ name: "think_light", if: 'intent == "question" and intent.confidence >= vars.min_confidence', then: { do: "set_thinking", level: "low" } },
	],
	summary: "{label} → {intent}({intent.confidence}) ambiguous={ambiguous}",
	status: "intent {intent}",
};
