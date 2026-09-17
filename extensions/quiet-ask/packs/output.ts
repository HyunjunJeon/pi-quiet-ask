/**
 * output — read what a bash call printed.
 *
 * The gate sees intent; it cannot see a credential echoed into the
 * transcript, and it cannot tell a network hiccup from a type error.
 * `annotate` never blocks: it appends at most one line per matched rule to
 * the tool result so the model gets advice next to the evidence.
 *
 * Leak detection combines hard evidence with a probability: `redactions`
 * counts credentials the local patterns removed before the output left
 * the machine; `leaks_secret` is Jev's read of the redacted remainder.
 */

import type { PackSpec } from "../engine/pack.ts";

export const OUTPUT_PACK: PackSpec = {
	name: "output",
	description: "After bash prints: secret leak, failure class with advice",
	on: "tool_result",
	when: { tool: ["bash"], min_output_chars: 1 },
	mode: "enforce",
	state: ["tool", "arguments", "is_error", "output"],
	vars: { leak: 0.9, min_confidence: 0.6 },
	questions: {
		leaks_secret: {
			noul: "Does this output contain a secret or credential (API key, token, password, private key)? A `<REDACTED:…>` marker means a credential was present and removed locally.",
		},
		failure_class: {
			choice: "What kind of failure does this output show?",
			options: {
				no_failure: "the command succeeded or the output shows no error",
				transient: "network, rate limit, lock, or timing problem that may pass if retried unchanged",
				environment: "missing tool, wrong version, port in use, or other machine setup problem",
				code_bug: "a defect in the project's own code: compile error, failing test, exception",
				permission: "access denied, authentication failed, or insufficient privileges",
				user_error: "wrong arguments, wrong directory, typo, or misuse of the command",
			},
		},
	},
	rules: [
		{
			name: "leak",
			if: "redactions > 0 or leaks_secret >= vars.leak",
			then: [
				{
					do: "annotate",
					say: "this output appears to contain a secret or credential. Do not repeat the value in a reply, a file, or a command; refer to it by name instead.",
				},
				{ do: "warn", say: "secret in {tool} output (Jev p={leaks_secret}, {redactions} redacted locally)" },
			],
		},
		{
			name: "transient",
			if: 'failure_class == "transient" and failure_class.confidence >= vars.min_confidence',
			then: { do: "annotate", say: "this looks like a transient failure; retry the same command once before changing anything." },
		},
		{
			name: "environment",
			if: 'failure_class == "environment" and failure_class.confidence >= vars.min_confidence',
			then: { do: "annotate", say: "this looks like an environment problem; fix the machine setup (install, version, port) rather than the code." },
		},
		{
			name: "code_bug",
			if: 'failure_class == "code_bug" and failure_class.confidence >= vars.min_confidence',
			then: { do: "annotate", say: "this looks like a defect in the project's code; fix the code rather than retrying." },
		},
		{
			name: "permission",
			if: 'failure_class == "permission" and failure_class.confidence >= vars.min_confidence',
			then: { do: "annotate", say: "this is a permission or authentication failure; do not retry unchanged, ask the user how to proceed." },
		},
		{
			name: "user_error",
			if: 'failure_class == "user_error" and failure_class.confidence >= vars.min_confidence',
			then: { do: "annotate", say: "this looks like a mistake in how the command was invoked; fix the invocation before retrying." },
		},
	],
	summary: "{label} leak={leaks_secret}+{redactions}r class={failure_class}({failure_class.confidence})",
};
