/**
 * The evidence ledger: what actually happened during each prompt, as a
 * JSON file a human or another tool can read.
 *
 * `history.jsonl` answers "what did Jev say"; this file answers "what is
 * the state of the work". Per user prompt it keeps
 *
 *   files_changed     write/edit calls, in order
 *   commands          bash calls with exit state and a 300-char output head,
 *                     classified deterministically (test, typecheck, lint,
 *                     build, run, other)
 *   verifications     the subset that counts as checking the work, each
 *                     tagged with whether it ran after the last change
 *   phases            the task graph's per-turn phase / progress / drift
 *   runs              each agent run's final message head plus, when the
 *                     honest_finish pack judged it, its numbers
 *   decisions         every non-trivial Jev decision (block, confirm, steer,
 *                     auto-answer, suggestion, annotation) with its outcome
 *   status            derived: no_changes · in_progress · verified ·
 *                     unverified · blocked
 *
 * Deterministic facts come straight from pi hooks. Jev-based facts arrive
 * through the history store's listeners, so nothing here depends on a
 * pack's internals. The file is rewritten atomically after every change
 * and lives at `<agentDir>/pi-quiet-ask/evidence/<sessionId>.json` unless
 * `evidence.dir` says otherwise. Packs can read the current prompt's
 * ledger with `state: ["evidence"]`, and rules get `files_changed`,
 * `verifications`, and `verified_after_change` as plain facts.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { evidenceDir, type QuietAskConfig } from "./config.ts";
import type { DecisionOutcome, DecisionRecord, HistoryStore } from "./history.ts";

/** Published schema so a ledger file is validatable (and editable) on its own. */
export const EVIDENCE_SCHEMA_URL = "https://raw.githubusercontent.com/HyunjunJeon/pi-quiet-ask/main/schemas/evidence.schema.json";

export type CommandKind = "test" | "typecheck" | "lint" | "build" | "run" | "other";

export interface FileChange {
	at: string;
	/** Agent run within this prompt (1-based); pi's turn index restarts per run. */
	run: number;
	turn: number;
	tool: "write" | "edit";
	path: string;
	is_error: boolean;
}

export interface CommandRun {
	at: string;
	run: number;
	turn: number;
	command: string;
	kind: CommandKind;
	is_error: boolean;
	output_head: string;
}

export interface Verification extends CommandRun {
	/** No change was made after this ran, so it speaks for the current files. */
	after_last_change: boolean;
	passed: boolean;
}

export interface PhaseEntry {
	run?: number;
	turn: number;
	phase: string;
	confidence: number;
	progress: number;
	drift: number;
	tools: string[];
}

export interface RunEntry {
	ended_at: string;
	final_text: string;
	tool_count: number;
	/** From the honest_finish pack, when it judged this run. */
	claims_done?: number;
	verified?: number;
	hedged?: number;
}

export interface DecisionEntry {
	at: string;
	kind: string;
	action: string;
	summary: string;
	toolCallId?: string;
	outcome?: string;
	agreed?: boolean;
}

export type WorkStatus = "no_changes" | "in_progress" | "verified" | "unverified" | "blocked";

export interface PromptEvidence {
	index: number;
	started_at: string;
	request: string;
	intent?: { label: string; confidence: number };
	files_changed: FileChange[];
	commands: CommandRun[];
	verifications: Verification[];
	phases: PhaseEntry[];
	invariants: { name: string; turn: number }[];
	runs: RunEntry[];
	decisions: DecisionEntry[];
	status: WorkStatus;
}

export interface EvidenceFile {
	$schema?: string;
	version: 1;
	session_id: string;
	cwd: string;
	updated_at: string;
	prompts: PromptEvidence[];
}

const MAX_PROMPTS = 50;
const MAX_LIST = 200;
const MAX_TEXT = 300;
const MAX_REQUEST = 600;

/** Commands that count as checking the work. Order matters: first match wins. */
const COMMAND_KINDS: [CommandKind, RegExp][] = [
	["test", /\b(pytest|unittest|vitest|jest|mocha|ava|tap|go test|cargo test|mvn test|gradle test|dotnet test|rspec|phpunit|bun test|deno test|make test|(npm|pnpm|yarn|bun) (run )?test)\b/],
	["typecheck", /\b(tsc|mypy|pyright|pyre|flow check|(npm|pnpm|yarn|bun) run (typecheck|check|types))\b/],
	["lint", /\b(ruff|eslint|biome|flake8|pylint|golangci-lint|clippy|(npm|pnpm|yarn|bun) run (lint|format:check))\b/],
	["build", /\b(cargo build|go build|make(\s|$)|(npm|pnpm|yarn|bun) run build|docker build|gradle build|mvn (package|compile)|tsc -b)\b/],
	["run", /\b(python3?|node|deno|bun|ruby|php|go run|cargo run|java|\.\/\S+)\s+\S+/],
];

export function classifyCommand(command: string): CommandKind {
	for (const [kind, pattern] of COMMAND_KINDS) if (pattern.test(command)) return kind;
	return "other";
}

const VERIFYING: ReadonlySet<CommandKind> = new Set(["test", "typecheck", "lint", "build", "run"]);

function head(text: string, limit = MAX_TEXT): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block: unknown) => {
			const record = block as Record<string, unknown> | null;
			return record && record.type === "text" && typeof record.text === "string" ? record.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

function push<T>(list: T[], item: T): void {
	list.push(item);
	if (list.length > MAX_LIST) list.shift();
}

/** Derive the headline status from the facts. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isPromptEvidence(value: unknown): value is PromptEvidence {
	if (!isRecord(value)) return false;
	return (
		typeof value.index === "number" &&
		typeof value.started_at === "string" &&
		typeof value.request === "string" &&
		Array.isArray(value.files_changed) &&
		Array.isArray(value.commands) &&
		Array.isArray(value.verifications) &&
		Array.isArray(value.phases) &&
		Array.isArray(value.invariants) &&
		Array.isArray(value.runs) &&
		Array.isArray(value.decisions) &&
		typeof value.status === "string"
	);
}

/** Derive the headline status from the facts. */
export function deriveStatus(p: PromptEvidence): WorkStatus {
	if (p.decisions.at(-1)?.action === "block") return "blocked";
	if (p.files_changed.length === 0) return "no_changes";
	const passedAfter = p.verifications.some((v) => v.after_last_change && v.passed);
	if (passedAfter) return "verified";
	// Work has been done and at least one agent run ended: it was reported unverified.
	return p.runs.length > 0 ? "unverified" : "in_progress";
}

export class EvidenceStore {
	readonly file: EvidenceFile;
	private readonly pi: ExtensionAPI;
	private readonly config: QuietAskConfig;
	private readonly scrub: (text: string) => string;
	private path: string | undefined;
	private turn = 0;

	constructor(pi: ExtensionAPI, config: QuietAskConfig, scrub: (text: string) => string) {
		this.pi = pi;
		this.config = config;
		this.scrub = scrub;
		this.file = {
			$schema: EVIDENCE_SCHEMA_URL,
			version: 1,
			session_id: "",
			cwd: "",
			updated_at: new Date().toISOString(),
			prompts: [],
		};
	}

	filePath(): string | undefined {
		return this.path;
	}

	/** The prompt being worked on, created on demand so early hooks never miss. */
	current(): PromptEvidence {
		let p = this.file.prompts.at(-1);
		if (!p) {
			p = this.newPrompt("");
		}
		return p;
	}

	private newPrompt(request: string): PromptEvidence {
		const p: PromptEvidence = {
			index: this.file.prompts.length + 1,
			started_at: new Date().toISOString(),
			request: this.scrub(head(request, MAX_REQUEST)),
			files_changed: [],
			commands: [],
			verifications: [],
			phases: [],
			invariants: [],
			runs: [],
			decisions: [],
			status: "no_changes",
		};
		this.file.prompts.push(p);
		if (this.file.prompts.length > MAX_PROMPTS) this.file.prompts.shift();
		return p;
	}

	/** Point the ledger at this session's file; resume reloads the existing JSON. */
	bind(ctx: ExtensionContext): void {
		const id = ctx.sessionManager.getSessionId();
		this.path = join(evidenceDir(this.config), `${id || "session"}.json`);
		if (id !== this.file.session_id) {
			this.file.prompts.length = 0;
			this.load();
		}
		this.file.$schema = EVIDENCE_SCHEMA_URL;
		this.file.session_id = id;
		this.file.cwd = ctx.cwd;
	}

	/** Reload a previously written ledger. Corrupt or foreign files are ignored. */
	private load(): void {
		if (!this.path || !existsSync(this.path)) return;
		try {
			const raw = JSON.parse(readFileSync(this.path, "utf8")) as Partial<EvidenceFile>;
			if (raw.version !== 1 || !Array.isArray(raw.prompts)) return;
			this.file.prompts = raw.prompts.filter(isPromptEvidence);
			if (this.file.prompts.length > MAX_PROMPTS) this.file.prompts.splice(0, this.file.prompts.length - MAX_PROMPTS);
		} catch {
			// A broken ledger must not block the session; we start empty and overwrite.
		}
	}

	register(history: HistoryStore, ctx: ExtensionContext): void {
		this.bind(ctx);
		// Later session switches (/new, /resume) re-bind through the hook.
		this.pi.on("session_start", (_e, next) => this.bind(next));
		this.pi.on("input", (event) => {
			if (event.source === "extension") return undefined;
			const p = this.file.prompts.at(-1);
			// Reuse an empty placeholder created by an early hook.
			if (p && !p.request && p.files_changed.length === 0 && p.commands.length === 0) p.request = this.scrub(head(event.text, MAX_REQUEST));
			else this.newPrompt(event.text);
			this.turn = 0;
			this.flush();
			return undefined;
		});
		this.pi.on("before_agent_start", (event) => {
			const p = this.current();
			if (!p.request) p.request = this.scrub(head(event.prompt, MAX_REQUEST));
			return undefined;
		});
		this.pi.on("turn_start", (event) => {
			this.turn = event.turnIndex;
		});
		this.pi.on("tool_result", (event) => {
			this.onToolResult(event.toolName, event.input, event.isError, textOf(event.content));
			return undefined;
		});
		this.pi.on("agent_end", (event) => {
			const p = this.current();
			let finalText = "";
			let tools = 0;
			for (const raw of event.messages) {
				const m = raw as { role?: string; content?: unknown };
				if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
				for (const block of m.content as Record<string, unknown>[]) {
					if (block.type === "toolCall") tools += 1;
					else if (block.type === "text" && typeof block.text === "string" && block.text.trim()) finalText = block.text;
				}
			}
			push(p.runs, { ended_at: new Date().toISOString(), final_text: this.scrub(head(finalText)), tool_count: tools });
			p.status = deriveStatus(p);
			this.flush();
		});

		history.onRecord((record) => this.onDecision(record));
		history.onResolve((record, outcome) => this.onOutcome(record, outcome));
	}

	private onToolResult(tool: string, input: unknown, isError: boolean, output: string): void {
		const p = this.current();
		const args = (input ?? {}) as Record<string, unknown>;
		const at = new Date().toISOString();
		if ((tool === "write" || tool === "edit") && typeof args.path === "string") {
			push(p.files_changed, { at, run: p.runs.length + 1, turn: this.turn, tool, path: args.path, is_error: isError });
			// A new change invalidates earlier verifications for the "current files" question.
			for (const v of p.verifications) v.after_last_change = false;
		} else if (tool === "bash" && typeof args.command === "string") {
			const command = this.scrub(head(args.command, 200));
			const kind = classifyCommand(args.command);
			const run: CommandRun = { at, run: p.runs.length + 1, turn: this.turn, command, kind, is_error: isError, output_head: this.scrub(head(output)) };
			push(p.commands, run);
			if (VERIFYING.has(kind)) push(p.verifications, { ...run, after_last_change: true, passed: !isError });
		} else {
			return;
		}
		p.status = deriveStatus(p);
		this.flush();
	}

	/** Called by the graph tracker after each judged turn. */
	addPhase(entry: PhaseEntry, fired: string[]): void {
		const p = this.current();
		push(p.phases, { ...entry, run: p.runs.length + 1 });
		for (const name of fired) p.invariants.push({ name, turn: entry.turn });
		this.flush();
	}

	private onDecision(record: DecisionRecord): void {
		const p = this.current();
		if (record.kind === "intent") {
			const a = record.answers.intent as { choice?: string; confidence?: number } | undefined;
			if (a?.choice) p.intent = { label: a.choice, confidence: Number(a.confidence ?? 0) };
		}
		if (record.kind === "honest_finish") {
			const run = p.runs.at(-1);
			const n = (id: string) => Number((record.answers[id] as { noul?: number } | undefined)?.noul ?? Number.NaN);
			if (run) {
				run.claims_done = n("claims_done");
				run.verified = n("verified");
				run.hedged = n("hedged");
			}
		}
		if (record.action !== "pass" && record.action !== "note" && record.action !== "allow" && record.kind !== "graph") {
			push(p.decisions, { at: record.at, kind: record.kind, action: record.action, summary: record.summary, toolCallId: record.toolCallId });
		}
		p.status = deriveStatus(p);
		this.flush();
	}

	private onOutcome(record: DecisionRecord, outcome: DecisionOutcome): void {
		const p = this.current();
		const entry = p.decisions.find((d) => d.toolCallId && d.toolCallId === record.toolCallId);
		if (entry) {
			entry.outcome = outcome.description;
			entry.agreed = outcome.agreed;
		}
		this.flush();
	}

	/** Compact view for packs (`state: ["evidence"]`) and rule facts. */
	snapshot(): { state: Record<string, unknown>; facts: Record<string, unknown> } {
		const p = this.file.prompts.at(-1);
		if (!p) return { state: {}, facts: { files_changed: 0, verifications: 0, verified_after_change: false } };
		const verifiedAfter = p.verifications.some((v) => v.after_last_change && v.passed);
		return {
			state: {
				status: p.status,
				files_changed: p.files_changed.map((f) => f.path).slice(-20),
				verifications: p.verifications.slice(-5).map((v) => ({ command: v.command, kind: v.kind, passed: v.passed, after_last_change: v.after_last_change })),
				phases: p.phases.map((e) => e.phase),
				invariants: p.invariants.map((i) => i.name),
				last_run: p.runs.at(-1)?.final_text,
			},
			facts: { files_changed: p.files_changed.length, verifications: p.verifications.length, verified_after_change: verifiedAfter },
		};
	}

	private flush(): void {
		if (!this.config.evidence.file || !this.path) return;
		this.file.updated_at = new Date().toISOString();
		try {
			mkdirSync(dirname(this.path), { recursive: true });
			const tmp = `${this.path}.tmp`;
			writeFileSync(tmp, JSON.stringify(this.file, null, 2));
			renameSync(tmp, this.path);
		} catch {
			// The ledger must never break the agent.
		}
	}

	show(ctx: ExtensionCommandContext): void {
		const p = this.file.prompts.at(-1);
		if (!p) return void ctx.ui.notify(`evidence: nothing yet · ${this.path ?? "(no file)"}`, "info");
		const lines = [
			`prompt ${p.index} · ${p.status}${p.intent ? ` · intent ${p.intent.label}(${p.intent.confidence.toFixed(2)})` : ""}`,
			`request: ${p.request || "(none)"}`,
			`files changed (${p.files_changed.length}): ${p.files_changed.map((f) => `${f.tool} ${f.path}`).slice(-8).join(", ") || "-"}`,
			`commands (${p.commands.length}): ${p.commands.slice(-6).map((c) => `${c.kind}:${c.command}${c.is_error ? " ✗" : ""}`).join(" · ") || "-"}`,
			`verifications: ${p.verifications.map((v) => `${v.kind} ${v.passed ? "✓" : "✗"}${v.after_last_change ? " (current)" : " (stale)"}`).join(", ") || "-"}`,
			`phases: ${p.phases.map((e) => e.phase).join(" → ") || "-"}${p.invariants.length ? ` · invariants ${p.invariants.map((i) => i.name).join(",")}` : ""}`,
			`runs: ${p.runs.length}${p.runs.at(-1)?.claims_done !== undefined ? ` · last done=${p.runs.at(-1)!.claims_done!.toFixed(2)} verified=${p.runs.at(-1)!.verified!.toFixed(2)}` : ""}`,
			`decisions: ${p.decisions.slice(-6).map((d) => `${d.kind}:${d.action}${d.agreed === undefined ? "" : d.agreed ? " ✓" : " ✗"}`).join(", ") || "-"}`,
			`file: ${this.path ?? "(disabled)"}`,
		];
		ctx.ui.notify(lines.join("\n"), "info");
	}
}
