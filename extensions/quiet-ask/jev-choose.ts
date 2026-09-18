/**
 * `jev_choose`: the harness owns the option list.
 *
 * `jev_ask` lets the model invent Choice members. This tool builds the
 * criteria from the evidence ledger (or named arguments) so Jev can only
 * pick an observed id or `none`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { choice } from "@typesafe-ai/sdk";
import { Type } from "typebox";
import { consumeTarget } from "./choice.ts";
import type { JevClient } from "./client.ts";
import type { QuietAskConfig } from "./config.ts";
import type { EvidenceStore } from "./evidence.ts";
import type { HistoryStore } from "./history.ts";
import { prepareState } from "./redact.ts";
import type { RuntimeSettings } from "./settings.ts";
import { buildSpace, isSpaceName, spaceFallback } from "./space.ts";

const DEFAULT_INSTRUCTIONS: Record<string, string> = {
	unverified_files: "Which observed changed file still needs a check after the last edit?",
	recent_failures: "Which observed failed command is the one to address?",
	commands: "Which observed command is the relevant check?",
	verify_targets: "Which observed file or command should be verified next?",
	argument_paths: "Which path named in the arguments is the one that matters?",
};

export const JevChooseParams = Type.Object({
	space: Type.Union(
		[Type.Literal("unverified_files"), Type.Literal("recent_failures"), Type.Literal("commands"), Type.Literal("verify_targets"), Type.Literal("argument_paths")],
		{ description: "Closed set built from the evidence ledger (or arguments). Jev cannot invent members." },
	),
	instructions: Type.Optional(Type.String({ description: "Override the default question. Still one closed judgement." })),
	arguments: Type.Optional(Type.String({ description: "JSON object of tool arguments; used by argument_paths." })),
});

type JevChooseInput = {
	space: string;
	instructions?: string;
	arguments?: string;
};

export function registerJevChoose(
	pi: ExtensionAPI,
	client: JevClient,
	config: QuietAskConfig,
	settings: RuntimeSettings,
	history: HistoryStore,
	evidence: EvidenceStore,
): void {
	pi.registerTool({
		name: "jev_choose",
		label: "Jev choose",
		description:
			"Ask Jev to pick one member of an observed set (unverified files, failed commands, verify targets, argument paths). The harness builds the options from the evidence ledger; you cannot invent members. Returns the observed value or none.",
		promptSnippet: "jev_choose: pick one observed ledger item (file, failed command, check) with a probability; cannot invent members",
		promptGuidelines: [
			"Use jev_choose when the ledger already has the set (changed files, failed commands). Do not list those members yourself in jev_ask.",
		],
		parameters: JevChooseParams,
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const input = params as JevChooseInput;
			if (!isSpaceName(input.space)) {
				return { content: [{ type: "text", text: `jev_choose: unknown space "${input.space}"` }], isError: true, details: undefined };
			}
			let extraArgs: unknown;
			if (input.arguments) {
				try {
					extraArgs = JSON.parse(input.arguments);
				} catch {
					return { content: [{ type: "text", text: "jev_choose: arguments must be JSON" }], isError: true, details: undefined };
				}
			}
			const facts = { ...evidence.snapshot().space, arguments: extraArgs };
			const space = buildSpace(input.space, facts);
			if (space.options.length === 0) {
				settings.counters.jevChoose += 1;
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ choice: "none", value: null, reason: "empty space", fallback: spaceFallback(space.name), options: [] }, null, 2),
						},
					],
					details: { choice: "none", empty: true },
				};
			}
			const { state } = prepareState(
				{ space: input.space, options: space.options.map((o) => ({ id: o.id, kind: o.kind, value: o.value })), evidence: evidence.snapshot().state },
				{ stringChars: 400, maxChars: config.maxStateChars },
			);
			const questions = {
				pick: choice(input.instructions?.trim() || DEFAULT_INSTRUCTIONS[input.space], space.criteria),
			};
			const call = await client.ask(state, questions, { signal });
			settings.counters.jevChoose += 1;
			if (!call.result) {
				return {
					content: [{ type: "text", text: `jev_choose: no answer (${call.error ?? "unknown error"}). Decide without it.` }],
					isError: true,
					details: undefined,
				};
			}
			const option = consumeTarget(call.result.answers.pick, space);
			history.record(ctx, {
				kind: "jev_choose",
				toolCallId,
				tool: "jev_choose",
				action: option ? "pick" : "none",
				summary: `${input.space} → ${option?.value ?? "none"}`,
				answers: { ...call.result.answers },
				latencyMs: call.latencyMs,
				cached: call.cached,
				mode: settings.enabled ? "on" : "off",
				state,
			});
			const payload = {
				choice: option?.id ?? "none",
				value: option?.value ?? null,
				kind: option?.kind ?? null,
				fallback: option ? undefined : spaceFallback(space.name),
				options: space.options.map((o) => ({ id: o.id, kind: o.kind, value: o.value })),
				latency_ms: Math.round(call.latencyMs),
			};
			return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], details: payload };
		},
	});
}
