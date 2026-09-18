/**
 * `jev_ask`: let the model ask Jev the same kind of typed question itself.
 *
 * Useful for decisions that should come back as numbers rather than prose:
 * "is this test output relevant?", "which bucket is this issue?", "how
 * thorough is this diff?". One judgement per entry; the model combines the
 * answers. The state is redacted and truncated like everything else.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type ChoiceCriteria, choice, noul, type Questions, type ScoreCriteria, score } from "@typesafe-ai/sdk";
import { Type } from "typebox";
import type { JevClient } from "./client.ts";
import type { QuietAskConfig } from "./config.ts";
import type { HistoryStore } from "./history.ts";
import { prepareState } from "./redact.ts";
import type { RuntimeSettings } from "./settings.ts";

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Key for this answer in the result" }),
	type: Type.Union([Type.Literal("noul"), Type.Literal("choice"), Type.Literal("score")], {
		description: "noul = probability of yes; choice = one of options; score = position on ordered levels",
	}),
	instructions: Type.String({ description: "The question. Ask about what the state says, one judgement only." }),
	options: Type.Optional(
		Type.Array(
			Type.Object({
				name: Type.String(),
				description: Type.Optional(Type.String()),
			}),
			{ description: "choice only: include a no-match option such as `other`" },
		),
	),
	levels: Type.Optional(Type.Array(Type.String(), { description: "score only: 2+ ordered level descriptions, lowest first" })),
});

export const JevAskParams = Type.Object({
	state: Type.String({ description: "The text or JSON to judge: tool output, a diff, a message" }),
	questions: Type.Array(QuestionSchema, { minItems: 1, maxItems: 16 }),
});

type JevAskInput = {
	state: string;
	questions: {
		id: string;
		type: "noul" | "choice" | "score";
		instructions: string;
		options?: { name: string; description?: string }[];
		levels?: string[];
	}[];
};

function buildQuestions(input: JevAskInput): Questions {
	const out: Questions = {};
	for (const q of input.questions) {
		if (q.type === "noul") {
			out[q.id] = noul(q.instructions);
		} else if (q.type === "choice") {
			if (!q.options || q.options.length < 2) throw new Error(`choice question "${q.id}" needs at least two options`);
			const criteria: ChoiceCriteria = {};
			for (const o of q.options) criteria[o.name] = o.description ?? null;
			out[q.id] = choice(q.instructions, criteria);
		} else {
			if (!q.levels || q.levels.length < 2) throw new Error(`score question "${q.id}" needs at least two levels`);
			out[q.id] = score(q.instructions, q.levels as unknown as ScoreCriteria);
		}
	}
	return out;
}

function parseState(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

export function registerJevAsk(
	pi: ExtensionAPI,
	client: JevClient,
	config: QuietAskConfig,
	settings: RuntimeSettings,
	history: HistoryStore,
): void {
	pi.registerTool({
		name: "jev_ask",
		label: "Jev",
		description:
			"Ask TypeSafe Jev typed questions about a piece of state and get calibrated probabilities back instead of prose. Types: noul (P(yes)), choice (pick one of options with a distribution), score (expected position on ordered levels). Ask one thing per question and combine the answers yourself.",
		promptSnippet: "jev_ask: typed yes/no, choice, or score judgements about text with calibrated probabilities",
		promptGuidelines: [
			"Use jev_ask for closed judgements (relevant? which bucket? how severe?) where a probability is more useful than a sentence.",
			"If the evidence ledger already has the set (changed files, failed commands), call jev_choose instead of inventing options here.",
		],
		parameters: JevAskParams,
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const input = params as JevAskInput;
			let questions: Questions;
			try {
				questions = buildQuestions(input);
			} catch (error) {
				return { content: [{ type: "text", text: `jev_ask: ${(error as Error).message}` }], isError: true, details: undefined };
			}
			const { state } = prepareState(parseState(input.state), { stringChars: 4000, maxChars: config.maxStateChars });
			const call = await client.ask(state, questions, { signal });
			settings.counters.jevAsk += 1;
			if (!call.result) {
				return {
					content: [{ type: "text", text: `jev_ask: no answer (${call.error ?? "unknown error"}). Decide without it.` }],
					isError: true,
					details: undefined,
				};
			}
			history.record(ctx, {
				kind: "jev_ask",
				toolCallId,
				tool: "jev_ask",
				action: "answer",
				summary: Object.keys(questions).join(", "),
				answers: { ...call.result.answers },
				latencyMs: call.latencyMs,
				cached: call.cached,
				mode: settings.enabled ? "on" : "off",
				state,
			});
			const payload = {
				model: call.result.model,
				answers: call.result.answers,
				usage: call.result.usage,
				latency_ms: Math.round(call.latencyMs),
			};
			return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], details: payload };
		},
	});
}
