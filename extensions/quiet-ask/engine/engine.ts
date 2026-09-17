/**
 * The rule engine: run packs on pi hooks, ask Jev, apply the matching
 * rules' actions.
 *
 * One hook handler is registered per hook that at least one pack uses.
 * For each event every enabled pack on that hook is judged concurrently
 * (they share the Jev client's cache and in-flight map), then actions are
 * applied in pack order. All failure paths fail open: no answer, no action.
 *
 * Modes:
 *   shadow   intervening actions (block, confirm, steer, set_thinking,
 *            set_tools) become warnings; annotate/warn/status/tag still run
 *   enforce  everything runs
 *
 * Every judgement is recorded with `history.record(kind = pack name)`.
 */

import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { JevClient } from "../client.ts";
import type { QuietAskConfig } from "../config.ts";
import type { HistoryStore } from "../history.ts";
import { prepareState } from "../redact.ts";
import type { RuntimeSettings } from "../settings.ts";
import { render, type Scope, test } from "./expr.ts";
import { type Action, type Hook, INTERVENING, type Pack, type PackMode } from "./pack.ts";
import { buildState, type HookInput, type StateProviders } from "./state.ts";

/** Tools this package registers or that another judge owns; never judged by packs. */
const SKIP_TOOLS = new Set(["jev_ask", "ask_user"]);

export interface PackVerdict {
	pack: string;
	hook: Hook;
	mode: PackMode;
	tool?: string;
	toolCallId?: string;
	answers: Record<string, unknown>;
	/** Names of the rules whose condition held. */
	matched: string[];
	actions: Action[];
	scope: Scope;
	state: unknown;
	latencyMs: number;
	cached: boolean;
}

export interface EngineDeps {
	pi: ExtensionAPI;
	client: JevClient;
	config: QuietAskConfig;
	settings: RuntimeSettings;
	history: HistoryStore;
	providers?: StateProviders;
}

/** Turn the SDK's typed answers into rule scope: bare id = headline value. */
export function answersToScope(answers: Record<string, unknown>): Scope {
	const scope: Scope = {};
	for (const [id, raw] of Object.entries(answers)) {
		const a = raw as Record<string, unknown>;
		if (!a || typeof a !== "object") continue;
		if (a.type === "noul") scope[id] = { value: a.noul, noul: a.noul };
		else if (a.type === "choice") scope[id] = { value: a.choice, choice: a.choice, confidence: a.confidence, p: a.probabilities ?? {} };
		else if (a.type === "score") scope[id] = { value: a.score, score: a.score, confidence: a.confidence, p: a.probabilities ?? {} };
		else scope[id] = { value: a };
	}
	return scope;
}

/** `destructive=0.93 impact=2.60(c0.40) intent=debug(0.71)`. */
export function compactAnswers(answers: Record<string, unknown>): string {
	return Object.entries(answers)
		.map(([id, raw]) => {
			const a = raw as Record<string, unknown>;
			if (a?.type === "noul") return `${id}=${Number(a.noul).toFixed(2)}`;
			if (a?.type === "choice") return `${id}=${String(a.choice)}(${Number(a.confidence).toFixed(2)})`;
			if (a?.type === "score") return `${id}=${Number(a.score).toFixed(2)}(c${Number(a.confidence).toFixed(2)})`;
			return `${id}=?`;
		})
		.join(" ");
}

const ACTION_RANK: Record<Action["do"], number> = {
	block: 9,
	confirm: 8,
	steer: 7,
	set_thinking: 6,
	set_tools: 5,
	annotate: 4,
	warn: 3,
	tag: 2,
	status: 1,
	allow: 0,
};

/** One word for the history list: the strongest action a matched rule asked for. */
function headlineAction(verdict: PackVerdict, shadowed: boolean): string {
	if (verdict.matched.length === 0) return "pass";
	let best: Action | undefined;
	for (const action of verdict.actions) {
		if (action.do === "status") continue; // decoration, not a decision
		if (!best || ACTION_RANK[action.do] > ACTION_RANK[best.do]) best = action;
	}
	if (!best) return "note";
	const label = best.do === "tag" ? render(best.label, verdict.scope) : best.do === "set_thinking" ? `set_thinking:${best.level}` : best.do;
	return shadowed && INTERVENING.has(best.do) ? `shadow:${label}` : label;
}

export class Engine {
	readonly packs: Pack[];
	private readonly deps: EngineDeps;
	/** Steers sent since the last real user input, per pack. */
	private readonly steersThisPrompt = new Map<string, number>();

	constructor(deps: EngineDeps, packs: Pack[]) {
		this.deps = deps;
		this.packs = packs;
	}

	byHook(hook: Hook): Pack[] {
		return this.packs.filter((pack) => pack.on === hook);
	}

	find(name: string): Pack | undefined {
		return this.packs.find((pack) => pack.name === name);
	}

	private active(hook: Hook): Pack[] {
		if (!this.deps.settings.enabled) return [];
		return this.byHook(hook).filter((pack) => pack.enabled);
	}

	/** Filter a pack against the event before spending a Jev call. */
	private applies(pack: Pack, input: HookInput, hasError: boolean): boolean {
		const when = pack.when;
		if (input.tool && SKIP_TOOLS.has(input.tool)) return false;
		if (when.tool && (!input.tool || !when.tool.includes(input.tool))) return false;
		if (when.is_error !== undefined && (input.isError ?? false) !== when.is_error) return false;
		if (when.min_turn_index !== undefined && (input.turnIndex ?? 0) < when.min_turn_index) return false;
		if (when.has_error && !hasError) return false;
		if (when.min_output_chars !== undefined && (input.output?.length ?? 0) < when.min_output_chars) return false;
		return true;
	}

	/** Build state, ask Jev, evaluate rules. Pure with respect to pi: no actions run here. */
	async judge(pack: Pack, input: HookInput, ctx: ExtensionContext, label = ""): Promise<PackVerdict | undefined> {
		const { client, config } = this.deps;
		const built = buildState(pack.state, input, ctx, this.deps.providers ?? {}, config.outputChars);
		const { state, redactions } = prepareState(built.state, { stringChars: config.argumentChars, maxChars: config.maxStateChars });
		const call = await client.ask(state, pack.questions, { signal: ctx.signal, cacheSeconds: pack.cacheSeconds });
		if (!call.result) return undefined;

		const answers = { ...call.result.answers } as Record<string, unknown>;
		const scope: Scope = {
			...answersToScope(answers),
			...built.scope,
			vars: pack.vars,
			redactions,
			mode: pack.mode,
			hook: pack.on,
			pack: pack.name,
			label: client.scrub(label),
			answers: compactAnswers(answers),
		};
		const matched: string[] = [];
		const actions: Action[] = [];
		for (const rule of pack.rules) {
			if (!test(rule.expr, scope)) continue;
			matched.push(rule.name);
			actions.push(...rule.actions);
			if (rule.actions.some((a) => a.do === "allow")) break;
		}
		scope.matched = matched;
		scope.reasons = matched.join(", ");

		return {
			pack: pack.name,
			hook: pack.on,
			mode: pack.mode,
			tool: input.tool,
			toolCallId: input.toolCallId,
			answers,
			matched,
			actions,
			scope,
			state,
			latencyMs: call.latencyMs,
			cached: call.cached,
		};
	}

	private summarize(pack: Pack, verdict: PackVerdict): string {
		const text = pack.summary ? render(pack.summary, verdict.scope) : `${String(verdict.scope.label)} · ${compactAnswers(verdict.answers)}`;
		const tail = verdict.matched.length ? ` [${verdict.matched.join(",")}]` : "";
		return this.deps.client.scrub(`${text}${tail}`).slice(0, 160);
	}

	private record(ctx: ExtensionContext, pack: Pack, verdict: PackVerdict, action: string, summary: string) {
		const stats = this.deps.settings.packStats(pack.name);
		stats.judged += 1;
		if (verdict.matched.length) stats.matched += 1;
		if (INTERVENING.has(action.replace(/^shadow:/, "").split(":")[0] as Action["do"]) && !action.startsWith("shadow:")) stats.intervened += 1;
		this.deps.settings.lastByPack.set(pack.name, verdict);
		return this.deps.history.record(ctx, {
			kind: pack.name,
			toolCallId: verdict.toolCallId,
			tool: verdict.tool,
			action,
			summary,
			answers: verdict.answers,
			latencyMs: verdict.latencyMs,
			cached: verdict.cached,
			mode: pack.mode,
			state: verdict.state,
		});
	}

	private say(ctx: ExtensionContext, text: string, level: "info" | "warning") {
		if (ctx.hasUI) ctx.ui.notify(this.deps.client.scrub(text), level);
	}

	/** Actions that are the same on every hook. Returns the ones the caller must handle. */
	private applyCommon(ctx: ExtensionContext, pack: Pack, verdict: PackVerdict): Action[] {
		if (pack.status && ctx.hasUI) ctx.ui.setStatus(`quiet:${pack.name}`, this.deps.client.scrub(render(pack.status, verdict.scope)));
		const rest: Action[] = [];
		for (const action of verdict.actions) {
			const shadowed = pack.mode === "shadow" && INTERVENING.has(action.do);
			if (shadowed) {
				const what = action.do === "set_thinking" ? `set_thinking ${action.level}` : action.do === "set_tools" ? `set_tools ${action.tools.join(",")}` : action.do;
				const why = "say" in action && action.say ? `: ${render(action.say, verdict.scope)}` : "";
				const loud = action.do === "block" || action.do === "confirm" || action.do === "steer";
				this.say(ctx, `pi-quiet-ask ${pack.name} (shadow) would ${what}${why}`, loud ? "warning" : "info");
				continue;
			}
			switch (action.do) {
				case "warn":
					this.say(ctx, `pi-quiet-ask ${pack.name}: ${render(action.say, verdict.scope)}`, "warning");
					break;
				case "status":
					if (ctx.hasUI) ctx.ui.setStatus(`quiet:${pack.name}`, this.deps.client.scrub(render(action.say, verdict.scope)));
					break;
				case "set_thinking":
					this.deps.pi.setThinkingLevel(action.level);
					this.say(ctx, `pi-quiet-ask ${pack.name}: thinking → ${action.level}`, "info");
					break;
				case "set_tools":
					this.deps.pi.setActiveTools(action.tools);
					this.say(ctx, `pi-quiet-ask ${pack.name}: tools → ${action.tools.join(", ")}`, "info");
					break;
				case "tag":
				case "allow":
					break;
				default:
					rest.push(action);
			}
		}
		return rest;
	}

	private steer(ctx: ExtensionContext, pack: Pack, action: Extract<Action, { do: "steer" }>, verdict: PackVerdict, deliverAs: "steer" | "followUp"): boolean {
		const count = this.steersThisPrompt.get(pack.name) ?? 0;
		if (count >= (action.maxPerPrompt ?? 1)) return false;
		this.steersThisPrompt.set(pack.name, count + 1);
		const text = this.deps.client.scrub(render(action.say, verdict.scope));
		this.deps.pi.sendMessage(
			{ customType: "pi-quiet-ask:steer", content: `[pi-quiet-ask ${pack.name}] ${text}`, display: true, details: { pack: pack.name, matched: verdict.matched } },
			{ deliverAs },
		);
		this.say(ctx, `pi-quiet-ask ${pack.name} steered the agent: ${text}`, "info");
		return true;
	}

	/** Register one handler per hook in use. */
	register(): void {
		const { pi } = this.deps;
		const hooks = new Set(this.packs.map((pack) => pack.on));

		pi.on("input", (event) => {
			if (event.source !== "extension") this.steersThisPrompt.clear();
			return undefined;
		});

		if (hooks.has("tool_call")) pi.on("tool_call", (event, ctx) => this.onToolCall(event, ctx));
		if (hooks.has("tool_result")) pi.on("tool_result", (event, ctx) => this.onToolResult(event, ctx));
		if (hooks.has("before_agent_start")) {
			pi.on("before_agent_start", async (event, ctx) => {
				await this.runSimple("before_agent_start", { hook: "before_agent_start", prompt: event.prompt }, ctx, event.prompt.slice(0, 80));
				return undefined;
			});
		}
		if (hooks.has("turn_end")) {
			pi.on("turn_end", async (event, ctx) => {
				const hasError = event.toolResults.some((r) => r.isError);
				await this.runSimple(
					"turn_end",
					{ hook: "turn_end", messages: [event.message], toolResults: event.toolResults, turnIndex: event.turnIndex },
					ctx,
					`turn ${event.turnIndex}`,
					hasError,
					"steer",
				);
			});
		}
		if (hooks.has("agent_end")) {
			pi.on("agent_end", async (event, ctx) => {
				await this.runSimple("agent_end", { hook: "agent_end", messages: event.messages }, ctx, "run end", false, "followUp");
			});
		}
	}

	/** Hooks whose only special action is steer. */
	private async runSimple(hook: Hook, input: HookInput, ctx: ExtensionContext, label: string, hasError = false, deliverAs: "steer" | "followUp" = "steer"): Promise<void> {
		const packs = this.active(hook).filter((pack) => this.applies(pack, input, hasError));
		if (packs.length === 0) return;
		const verdicts = await Promise.all(packs.map((pack) => this.judge(pack, input, ctx, label)));
		for (let i = 0; i < packs.length; i += 1) {
			const pack = packs[i];
			const verdict = verdicts[i];
			if (!verdict) continue;
			const rest = this.applyCommon(ctx, pack, verdict);
			let action = headlineAction(verdict, pack.mode === "shadow");
			for (const a of rest) {
				if (a.do === "steer" && !this.steer(ctx, pack, a, verdict, deliverAs)) action = "steer:capped";
			}
			this.record(ctx, pack, verdict, action, this.summarize(pack, verdict));
		}
	}

	private describeCall(tool: string, input: unknown): string {
		const record = (input ?? {}) as Record<string, unknown>;
		if (typeof record.command === "string") return record.command;
		if (typeof record.path === "string") return `${tool} ${record.path}`;
		return tool;
	}

	private async onToolCall(event: ToolCallEvent, ctx: ExtensionContext): Promise<{ block: true; reason: string } | undefined> {
		const input: HookInput = { hook: "tool_call", tool: event.toolName, toolCallId: event.toolCallId, arguments: event.input };
		const packs = this.active("tool_call").filter((pack) => this.applies(pack, input, false));
		if (packs.length === 0) return undefined;
		const label = this.describeCall(event.toolName, event.input).slice(0, 120);
		const verdicts = await Promise.all(packs.map((pack) => this.judge(pack, input, ctx, label)));

		for (let i = 0; i < packs.length; i += 1) {
			const pack = packs[i];
			const verdict = verdicts[i];
			if (!verdict) continue; // fail open
			const rest = this.applyCommon(ctx, pack, verdict);
			const action = headlineAction(verdict, pack.mode === "shadow");
			const summary = this.summarize(pack, verdict);

			const block = rest.find((a): a is Extract<Action, { do: "block" }> => a.do === "block");
			const confirm = rest.find((a): a is Extract<Action, { do: "confirm" }> => a.do === "confirm");
			if (block) {
				this.record(ctx, pack, verdict, action, summary);
				const reason = block.say ? render(block.say, verdict.scope) : `Blocked by pi-quiet-ask ${pack.name} (${verdict.matched.join(", ")}). Explain to the user and propose a safer alternative instead of retrying.`;
				return { block: true, reason: this.deps.client.scrub(reason) };
			}
			if (confirm) {
				if (!ctx.hasUI) {
					if (this.deps.config.headlessConfirm === "block") {
						this.record(ctx, pack, verdict, "block", summary);
						return {
							block: true,
							reason: `Blocked by pi-quiet-ask ${pack.name} (${verdict.matched.join(", ")}). No UI is available to confirm. Explain to the user and propose a safer alternative instead of retrying.`,
						};
					}
					this.record(ctx, pack, verdict, "warn", summary);
					continue;
				}
				const shown = this.deps.client.scrub(JSON.stringify(event.input, null, 2));
				const title = confirm.say ? render(confirm.say, verdict.scope) : `${event.toolName} flagged (${verdict.matched.join(", ")})`;
				const ok = await ctx.ui.confirm(`pi-quiet-ask ${pack.name}: ${this.deps.client.scrub(title)}`, `${compactAnswers(verdict.answers)}\n\n${shown.length > 800 ? `${shown.slice(0, 800)}…` : shown}\n\nRun it?`);
				const record = this.record(ctx, pack, verdict, "confirm", summary);
				this.deps.history.resolve(record.toolCallId ?? "", { at: new Date().toISOString(), description: ok ? "user approved" : "user declined", agreed: !ok });
				if (!ok) return { block: true, reason: `User declined after pi-quiet-ask ${pack.name} flagged this call (${verdict.matched.join(", ")}).` };
				continue;
			}
			this.record(ctx, pack, verdict, action, summary);
		}
		return undefined;
	}

	private async onToolResult(event: ToolResultEvent, ctx: ExtensionContext): Promise<{ content: ToolResultEvent["content"] } | undefined> {
		const output = event.content
			.map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
			.filter(Boolean)
			.join("\n");
		const input: HookInput = { hook: "tool_result", tool: event.toolName, toolCallId: event.toolCallId, arguments: event.input, output, isError: event.isError };
		const packs = this.active("tool_result").filter((pack) => this.applies(pack, input, event.isError));
		if (packs.length === 0 || !output.trim()) return undefined;
		const label = this.describeCall(event.toolName, event.input).slice(0, 120);
		const verdicts = await Promise.all(packs.map((pack) => this.judge(pack, input, ctx, label)));

		const notes: string[] = [];
		for (let i = 0; i < packs.length; i += 1) {
			const pack = packs[i];
			const verdict = verdicts[i];
			if (!verdict) continue;
			const rest = this.applyCommon(ctx, pack, verdict);
			for (const a of rest) if (a.do === "annotate") notes.push(`pi-quiet-ask: ${this.deps.client.scrub(render(a.say, verdict.scope))}`);
			this.record(ctx, pack, verdict, headlineAction(verdict, pack.mode === "shadow"), this.summarize(pack, verdict));
		}
		if (notes.length === 0) return undefined;
		return { content: [...event.content, { type: "text", text: notes.join("\n") }] };
	}
}
