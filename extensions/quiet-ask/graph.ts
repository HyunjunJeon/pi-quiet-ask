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
 * Default is enforce: skipping verify after implement, looping in
 * explore, or drifting two turns in a row steers the agent once per
 * prompt. The path is session-scoped; a new user prompt is the next
 * chapter, not a reset. The HUD prints ledger facts for the previous
 * and current prompt under the boxes. Shadow keeps the HUD and history
 * without changing the run. Everything fails open.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { choice, noul, type Questions } from "@typesafe-ai/sdk";
import { consumeTarget } from "./choice.ts";
import type { JevClient } from "./client.ts";
import type { QuietAskConfig } from "./config.ts";
import { buildConversationState } from "./context.ts";
import { lastAssistantText, type ToolBrief, toolBriefs } from "./engine/state.ts";
import type { EvidenceStore, HudStory } from "./evidence.ts";
import type { HistoryStore } from "./history.ts";
import { prepareState } from "./redact.ts";
import type { RuntimeSettings } from "./settings.ts";
import { buildSpace, type ObservedSpace, spaceFactsFromPrompt } from "./space.ts";
import { GENERIC_INVARIANT_STEER, renderInvariantSteer } from "./steer.ts";

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

const VERIFY_TARGET = "If this turn is reporting after untested changes, which observed file or command should be checked? Choose none if no listed item is a real check.";

/** Phase questions plus a speculative verify_target head from the ledger. */
export function graphQuestions(space: ObservedSpace): Questions {
	const questions: Questions = { ...GRAPH_QUESTIONS };
	if (space.options.length > 0) questions.verify_target = choice(VERIFY_TARGET, space.criteria);
	return questions;
}

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

/** @deprecated Use GENERIC_INVARIANT_STEER / renderInvariantSteer. */
export const INVARIANT_STEER = GENERIC_INVARIANT_STEER;

function emptyGraph(): GraphState {
	const visits = Object.fromEntries(PHASES.map((p) => [p, 0])) as Record<Phase, number>;
	return { startedAt: new Date().toISOString(), turns: [], visits, edges: {}, fired: [] };
}

function bar(value: number): string {
	const levels = "▁▂▃▄▅▆▇█";
	return levels[Math.min(levels.length - 1, Math.max(0, Math.round(value * (levels.length - 1))))];
}

const HUD_PHASES = PHASES.filter((p) => p !== "other");
/** Inner width fits the longest phase name (`implement`). */
const HUD_INNER = 9;

function padCenter(text: string, width: number): string {
	const extra = Math.max(0, width - text.length);
	const left = Math.floor(extra / 2);
	return `${" ".repeat(left)}${text}${" ".repeat(extra - left)}`.slice(0, width);
}

function visitMark(count: number, fill: "─" | "═"): string {
	if (count <= 0) return fill.repeat(HUD_INNER);
	const token = count === 1 ? "●" : count <= 9 ? `●${count}` : "●+";
	return padCenter(token, HUD_INNER).replaceAll(" ", fill);
}

function nodeGlyphs(phase: Phase, current: boolean, visits: number): [string, string, string] {
	const label = padCenter(phase, HUD_INNER);
	if (current) {
		return [`╔${"═".repeat(HUD_INNER)}╗`, `║${label}║`, `╚${visitMark(visits, "═")}╝`];
	}
	return [`┌${"─".repeat(HUD_INNER)}┐`, `│${label}│`, `└${visitMark(visits, "─")}┘`];
}

/** How a HUD node relates to the run so far. */
export type HudRole = "current" | "passed" | "ahead";

export function hudRole(phase: Phase, current: Phase | undefined, visits: number): HudRole {
	if (current === phase) return "current";
	if (visits > 0) return "passed";
	return "ahead";
}

/** Theme subset used to paint the TUI HUD. Tests pass a fake. */
export interface HudTheme {
	fg(color: "error" | "warning" | "muted" | "dim", text: string): string;
	bold(text: string): string;
	strikethrough(text: string): string;
}

export interface HudPaint {
	node(text: string, role: HudRole): string;
	connector(text: string): string;
	meta(text: string, warning: boolean): string;
}

/** Current = red, already visited = struck through, not yet = dim. */
export function hudPaint(theme: HudTheme): HudPaint {
	return {
		node(text, role) {
			if (role === "current") return theme.bold(theme.fg("error", text));
			if (role === "passed") return theme.strikethrough(theme.fg("muted", text));
			return theme.fg("dim", text);
		},
		connector(text) {
			return theme.fg("dim", text);
		},
		meta(text, warning) {
			return warning ? theme.fg("warning", text) : theme.fg("muted", text);
		},
	};
}

/**
 * Three-line box diagram so the path is visible in the TUI, not a
 * sentence mixed into the footer. Current phase is the double box;
 * with a theme, current is red, passed is struck through, ahead is dim.
 *
 * ```
 * ┌─────────┐  ┌─────────┐  ┌─────────┐  ╔═════════╗  ┌─────────┐  ┌─────────┐
 * │ clarify │──│ explore │──│  plan   │──║implement║──│ verify  │──│ report  │
 * └─────────┘  └────●────┘  └─────────┘  ╚════●════╝  └─────────┘  └─────────┘
 * ```
 */
export function formatHud(graph: GraphState, paint?: HudPaint, story?: HudStory): string[] {
	const last = graph.turns.at(-1)?.phase;
	const nodes = HUD_PHASES.map((phase) => {
		const role = hudRole(phase, last, graph.visits[phase]);
		const glyphs = nodeGlyphs(phase, role === "current", graph.visits[phase]);
		return paint ? (glyphs.map((g) => paint.node(g, role)) as [string, string, string]) : glyphs;
	});
	const gap = paint ? paint.connector("  ") : "  ";
	const link = paint ? paint.connector("──") : "──";
	const join = (row: 0 | 1 | 2, connector: string) => nodes.map((n) => n[row]).join(connector);
	const lines = [join(0, gap), join(1, link), join(2, gap)];
	const warn = graph.fired.length > 0 || (story?.now?.includes("unverified") ?? false) || (story?.now?.includes("blocked") ?? false);
	const add = (text: string) => {
		lines.push(paint ? paint.meta(text, warn) : text);
	};
	if (story?.prev) add(story.prev);
	if (story?.now) add(story.now);
	else if (graph.turns.length === 0) add("waiting for first turn");
	if (story?.session) add(story.session);
	else if (graph.turns.length > 0) {
		const flags = graph.fired.length ? `  ⚠ ${graph.fired.map((f) => f.name).join(",")}` : "";
		const other = last === "other" ? "  phase=other" : "";
		add(`path ${graph.turns.map((t) => t.phase).join("→")}${flags}${other}`);
	}
	return lines;
}

/** Compact one-liner for status dumps. Prefer `formatHud` in the TUI. */
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
	if (graph.turns.length === 0) return [...formatHud(graph)].join("\n");
	const lines = [
		...formatHud(graph),
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
	/** Index in `graph.turns` where the current user prompt started. */
	private chapterStart = 0;

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
		this.chapterStart = 0;
	}

	register(): void {
		this.pi.on("input", (event, ctx) => {
			if (event.source === "extension") return undefined;
			// New user prompt is the next chapter of the same session, not a
			// new graph. Keep the path; allow invariants to fire again.
			this.steered.clear();
			this.graph.fired = [];
			this.chapterStart = this.graph.turns.length;
			if (ctx.hasUI && this.config.graph.hud) this.draw(ctx);
			return undefined;
		});
		this.pi.on("turn_end", async (event, ctx) => {
			if (!this.settings.enabled || !this.settings.graphEnabled) return;
			await this.judgeTurn(event, ctx);
		});
		this.pi.on("session_start", (_e, ctx) => {
			this.reset();
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
		const space = this.evidence ? buildSpace("verify_targets", spaceFactsFromPrompt(this.evidence.current())) : buildSpace("verify_targets", {});
		const questions = graphQuestions(space);
		const call = await this.client.ask(state, questions, { signal: ctx.signal });
		if (!call.result) return;
		const a = call.result.answers as unknown as {
			phase: { choice: Phase; confidence: number };
			progress: { noul: number };
			drift: { noul: number };
			verify_target?: unknown;
		};
		const verifyTarget = consumeTarget(a.verify_target, space);
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
		this.evidence?.addPhase(record, fired, previous?.phase ?? null);
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
					{
						customType: "pi-quiet-ask:steer",
						content: `[pi-quiet-ask graph] ${renderInvariantSteer(name, name === "report_without_verify" ? verifyTarget : undefined)}`,
						display: true,
						details: { pack: "graph", matched: [name], target: verifyTarget?.value },
					},
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
		const chapter = g.turns.slice(this.chapterStart);
		const chapterVisits = Object.fromEntries(PHASES.map((p) => [p, 0])) as Record<Phase, number>;
		for (const t of chapter) chapterVisits[t.phase] += 1;

		if (record.phase === "report" && chapterVisits.implement > 0 && chapterVisits.verify === 0 && !already("report_without_verify")) {
			fired.push("report_without_verify");
		}
		const tail = chapter.slice(-cfg.exploreLoop);
		if (
			tail.length === cfg.exploreLoop &&
			tail.every((t) => t.phase === "explore" && t.progress < cfg.stalled) &&
			!g.fired.some((f) => f.name === "explore_loop" && f.turn > record.turn - cfg.exploreLoop)
		) {
			fired.push("explore_loop");
		}
		const lastTwo = chapter.slice(-2);
		if (lastTwo.length === 2 && lastTwo.every((t) => t.drift >= cfg.drift) && !g.fired.some((f) => f.name === "drift" && f.turn >= record.turn - 1)) {
			fired.push("drift");
		}
		return fired;
	}

	draw(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget(
			"quiet-graph",
			(_tui, theme) => ({
				render: () => formatHud(this.graph, hudPaint(theme), this.evidence?.hudStory()),
				invalidate: () => {},
			}),
			{ placement: "aboveEditor" },
		);
	}

	show(ctx: ExtensionCommandContext): void {
		ctx.ui.notify(formatGraph(this.graph), "info");
	}
}
