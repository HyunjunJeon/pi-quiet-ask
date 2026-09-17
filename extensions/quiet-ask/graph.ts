/**
 * The task graph: a fixed state machine of coding-work phases, with Jev
 * deciding which node each turn belongs to.
 *
 * Jev cannot invent node names, so the graph is not generated per task.
 * Instead every coding run is read against the same six phases:
 *
 *   clarify → explore → plan → implement → verify → report
 *
 * At `turn_end` Jev gets this turn's tool trail, the assistant text, and
 * the path so far, and answers three closed questions: which phase, did
 * the turn make progress, is it drifting from the request. The tracker
 * updates visit counts and transitions, redraws the HUD, and checks
 * invariants that are plain code over the graph:
 *
 *   report_without_verify   implement visited, verify never, report now
 *   explore_loop            N consecutive explore turns without progress
 *   drift                   drift high for two turns in a row
 *
 * Read-only by default (shadow): the HUD and the history show what the
 * graph saw, nothing changes the agent. In enforce mode each invariant
 * steers once per prompt. Everything fails open.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { choice, noul } from "@typesafe-ai/sdk";
import type { JevClient } from "./client.ts";
import type { QuietAskConfig } from "./config.ts";
import { buildConversationState } from "./context.ts";
import { lastAssistantText, type ToolBrief, toolBriefs } from "./engine/state.ts";
import type { EvidenceStore } from "./evidence.ts";
import type { HistoryStore } from "./history.ts";
import { prepareState } from "./redact.ts";
import type { RuntimeSettings } from "./settings.ts";

export const PHASES = ["clarify", "explore", "plan", "implement", "verify", "report", "other"] as const;
export type Phase = (typeof PHASES)[number];

const PHASE_OPTIONS: Record<Phase, string | null> = {
	clarify: "asking the user a question or waiting on a decision",
	explore: "reading, searching, or listing code and files to understand the situation",
	plan: "laying out an approach or steps, without changing files yet",
	implement: "creating or editing code, config, or files",
	verify: "running tests, builds, type checks, linters, or the program to check the work",
	report: "summarising results or answering the user; the turn's main content is the final message",
	other: null,
};

const GRAPH_QUESTIONS = {
	phase: choice("Which phase of the coding workflow does this turn (`turn_tools` and `assistant_text`) belong to?", PHASE_OPTIONS),
	progress: noul("Did this turn move `user_request` forward (new information, a change, a check), rather than repeating or stalling?"),
	drift: noul("Is this turn working on something `user_request` did not ask for?"),
} as const;

export interface TurnRecord {
	turn: number;
	phase: Phase;
	confidence: number;
	progress: number;
	drift: number;
	tools: string[];
}

export interface GraphState {
	startedAt: string;
	turns: TurnRecord[];
	visits: Record<Phase, number>;
	/** "from>to" -> count. */
	edges: Record<string, number>;
	/** Invariants that fired this run, with the turn they fired on. */
	fired: { name: string; turn: number }[];
}

export interface GraphConfig {
	enabled: boolean;
	mode: "shadow" | "enforce";
	hud: boolean;
	/** Consecutive low-progress explore turns before `explore_loop` fires. */
	exploreLoop: number;
	/** Drift probability that counts as drifting. */
	drift: number;
	/** Progress probability below which an explore turn counts as stalled. */
	stalled: number;
}

const INVARIANT_STEER: Record<string, string> = {
	report_without_verify:
		"The graph shows code was changed (implement) but no verify phase ran before reporting. Run the relevant test, build, or type check now and include the real result in your report.",
	explore_loop: "Exploration has not produced progress for several turns. Commit to a plan from what you already know and start implementing, or ask the user the one question that is blocking you.",
	drift: "Recent turns appear to work on something the user did not ask for. Return to the original request; mention the tangent in one sentence if it matters.",
};

function emptyGraph(): GraphState {
	const visits = Object.fromEntries(PHASES.map((p) => [p, 0])) as Record<Phase, number>;
	return { startedAt: new Date().toISOString(), turns: [], visits, edges: {}, fired: [] };
}

function bar(value: number): string {
	const levels = "▁▂▃▄▅▆▇█";
	return levels[Math.min(levels.length - 1, Math.max(0, Math.round(value * (levels.length - 1))))];
}

/** One line: `clarify · explore●●● · plan · implement●● · verify · report` */
export function formatPath(graph: GraphState): string {
	return PHASES.filter((p) => p !== "other")
		.map((p) => {
			const n = graph.visits[p];
			const last = graph.turns.at(-1)?.phase === p;
			const dots = n === 0 ? "" : n <= 4 ? "●".repeat(n) : `●×${n}`;
			return last ? `[${p}${dots}]` : `${p}${dots}`;
		})
		.join(" · ");
}

export function formatGraph(graph: GraphState): string {
	if (graph.turns.length === 0) return "graph: no turns judged yet";
	const lines = [
		`path: ${graph.turns.map((t) => t.phase).join(" → ")}`,
		formatPath(graph),
		`progress: ${graph.turns.map((t) => bar(t.progress)).join("")}  drift: ${graph.turns.map((t) => bar(t.drift)).join("")}`,
		...graph.turns.map(
			(t) => `  turn ${String(t.turn).padStart(2)}  ${t.phase.padEnd(9)} c=${t.confidence.toFixed(2)} progress=${t.progress.toFixed(2)} drift=${t.drift.toFixed(2)}  ${t.tools.join(",") || "-"}`,
		),
	];
	const edges = Object.entries(graph.edges)
		.sort((a, b) => b[1] - a[1])
		.map(([k, v]) => `${k.replace(">", "→")}×${v}`)
		.join("  ");
	if (edges) lines.push(`transitions: ${edges}`);
	if (graph.fired.length) lines.push(`invariants: ${graph.fired.map((f) => `${f.name}@${f.turn}`).join(", ")}`);
	return lines.join("\n");
}

export class GraphTracker {
	graph: GraphState = emptyGraph();
	private readonly pi: ExtensionAPI;
	private readonly client: JevClient;
	private readonly config: QuietAskConfig;
	private readonly settings: RuntimeSettings;
	private readonly history: HistoryStore;
	private readonly evidence: EvidenceStore | undefined;
	private steered = new Set<string>();

	constructor(pi: ExtensionAPI, client: JevClient, config: QuietAskConfig, settings: RuntimeSettings, history: HistoryStore, evidence?: EvidenceStore) {
		this.pi = pi;
		this.client = client;
		this.config = config;
		this.settings = settings;
		this.history = history;
		this.evidence = evidence;
	}

	/** Compact view for packs that list `graph` in their state. */
	snapshot(): unknown {
		return {
			path: this.graph.turns.map((t) => t.phase),
			visits: this.graph.visits,
			last_progress: this.graph.turns.at(-1)?.progress,
			fired: this.graph.fired.map((f) => f.name),
		};
	}

	reset(): void {
		this.graph = emptyGraph();
		this.steered = new Set();
	}

	register(): void {
		this.pi.on("input", (event) => {
			if (event.source !== "extension") this.reset();
			return undefined;
		});
		this.pi.on("turn_end", async (event, ctx) => {
			if (!this.settings.enabled || !this.settings.graphEnabled) return;
			await this.judgeTurn(event, ctx);
		});
		this.pi.on("session_start", (_e, ctx) => {
			if (ctx.hasUI && this.config.graph.hud) this.draw(ctx);
		});
	}

	private async judgeTurn(event: TurnEndEvent, ctx: ExtensionContext): Promise<void> {
		const briefs: ToolBrief[] = toolBriefs([event.message, ...event.toolResults]);
		const conversation = buildConversationState(ctx);
		const { state } = prepareState(
			{
				user_request: conversation.user_request,
				path_so_far: this.graph.turns.map((t) => t.phase),
				turn_index: event.turnIndex,
				turn_tools: briefs,
				assistant_text: lastAssistantText([event.message]),
			},
			{ stringChars: this.config.argumentChars, maxChars: this.config.maxStateChars },
		);
		const call = await this.client.ask(state, GRAPH_QUESTIONS, { signal: ctx.signal });
		if (!call.result) return;
		const a = call.result.answers;
		const record: TurnRecord = {
			turn: event.turnIndex,
			phase: a.phase.choice,
			confidence: a.phase.confidence,
			progress: a.progress.noul,
			drift: a.drift.noul,
			tools: [...new Set(briefs.map((b) => b.tool))],
		};
		const previous = this.graph.turns.at(-1);
		this.graph.turns.push(record);
		this.graph.visits[record.phase] += 1;
		if (previous) {
			const key = `${previous.phase}>${record.phase}`;
			this.graph.edges[key] = (this.graph.edges[key] ?? 0) + 1;
		}

		const fired = this.checkInvariants(record);
		for (const name of fired) this.graph.fired.push({ name, turn: record.turn });
		this.evidence?.addPhase(record, fired);
		const stats = this.settings.packStats("graph");
		stats.judged += 1;
		if (fired.length) stats.matched += 1;

		let action = fired.length ? "note" : "pass";
		for (const name of fired) {
			if (this.config.graph.mode === "shadow") {
				if (ctx.hasUI) ctx.ui.notify(`pi-quiet-ask graph (shadow) would steer: ${name}`, "warning");
				action = `shadow:steer`;
			} else if (!this.steered.has(name)) {
				this.steered.add(name);
				stats.intervened += 1;
				this.pi.sendMessage(
					{ customType: "pi-quiet-ask:steer", content: `[pi-quiet-ask graph] ${INVARIANT_STEER[name]}`, display: true, details: { pack: "graph", matched: [name] } },
					{ deliverAs: "steer" },
				);
				if (ctx.hasUI) ctx.ui.notify(`pi-quiet-ask graph steered the agent: ${name}`, "info");
				action = "steer";
			}
		}

		this.history.record(ctx, {
			kind: "graph",
			action,
			summary: `turn ${record.turn} ${record.phase}(${record.confidence.toFixed(2)}) progress=${record.progress.toFixed(2)} drift=${record.drift.toFixed(2)}${fired.length ? ` [${fired.join(",")}]` : ""}`,
			answers: { ...a },
			latencyMs: call.latencyMs,
			cached: call.cached,
			mode: this.config.graph.mode,
			state,
		});
		if (ctx.hasUI && this.config.graph.hud) this.draw(ctx);
	}

	private checkInvariants(record: TurnRecord): string[] {
		const g = this.graph;
		const cfg = this.config.graph;
		const fired: string[] = [];
		const already = (name: string) => g.fired.some((f) => f.name === name);

		if (record.phase === "report" && g.visits.implement > 0 && g.visits.verify === 0 && !already("report_without_verify")) {
			fired.push("report_without_verify");
		}
		const tail = g.turns.slice(-cfg.exploreLoop);
		if (
			tail.length === cfg.exploreLoop &&
			tail.every((t) => t.phase === "explore" && t.progress < cfg.stalled) &&
			!g.fired.some((f) => f.name === "explore_loop" && f.turn > record.turn - cfg.exploreLoop)
		) {
			fired.push("explore_loop");
		}
		const lastTwo = g.turns.slice(-2);
		if (lastTwo.length === 2 && lastTwo.every((t) => t.drift >= cfg.drift) && !g.fired.some((f) => f.name === "drift" && f.turn >= record.turn - 1)) {
			fired.push("drift");
		}
		return fired;
	}

	draw(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (this.graph.turns.length === 0) {
			ctx.ui.setWidget("quiet-graph", undefined);
			return;
		}
		const last = this.graph.turns.at(-1)!;
		const flags = this.graph.fired.length ? `  ⚠ ${this.graph.fired.map((f) => f.name).join(",")}` : "";
		ctx.ui.setWidget(
			"quiet-graph",
			[`graph ${formatPath(this.graph)}  progress ${this.graph.turns.map((t) => bar(t.progress)).join("")} drift ${last.drift.toFixed(2)}${flags}`],
			{ placement: "belowEditor" },
		);
	}

	show(ctx: ExtensionCommandContext): void {
		ctx.ui.notify(formatGraph(this.graph), "info");
	}
}
