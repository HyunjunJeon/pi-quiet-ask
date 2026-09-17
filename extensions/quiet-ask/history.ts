/**
 * Decision history: every judgement this package makes is recorded twice.
 *
 *   - as a `pi-quiet-ask:decision` session entry (`pi.appendEntry`), which
 *     lives with the session, follows branches, and never enters the LLM
 *     context;
 *   - optionally appended to `~/.pi/agent/pi-quiet-ask/history.jsonl` for
 *     cross-session review with ordinary tools (`jq`, `rg`).
 *
 * `/quiet history` lists the current branch's records and shows one in
 * full. Triage records are updated once the ask flow completes, so the
 * user can see what Jev proposed next to what was finally answered.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { historyFilePath, type QuietAskConfig } from "./config.ts";

export const DECISION_ENTRY = "pi-quiet-ask:decision";

/** Pack name (`gate`, `output`, `intent`, …) or one of the fixed judges. */
export type DecisionKind = string;

export interface DecisionRecord {
	/** ISO timestamp. */
	at: string;
	kind: DecisionKind;
	sessionId: string;
	toolCallId?: string;
	tool?: string;
	/** What the package did: allow, flag, confirm, block, auto, suggest, pass, warn, answer. */
	action: string;
	/** One line for lists. */
	summary: string;
	/** Raw Jev answers keyed by question id. */
	answers: Record<string, unknown>;
	latencyMs: number;
	cached: boolean;
	/** Mode in effect when the decision was made. */
	mode: string;
	/** Redacted, truncated state exactly as sent to Jev (omitted when disabled). */
	state?: unknown;
	/** Filled in later: what the user (or the flow) finally did. */
	outcome?: DecisionOutcome;
}

export interface DecisionOutcome {
	at: string;
	/** For triage: the final answers; for gate confirm: whether the user ran it. */
	description: string;
	/** For triage: did the final answer match Jev's pick? */
	agreed?: boolean;
}

export type RecordListener = (record: DecisionRecord) => void;
export type ResolveListener = (record: DecisionRecord, outcome: DecisionOutcome) => void;

export class HistoryStore {
	/** In-memory copy for this process, keyed by toolCallId when present. */
	private readonly byToolCall = new Map<string, DecisionRecord>();
	private readonly recent: DecisionRecord[] = [];
	private readonly recordListeners: RecordListener[] = [];
	private readonly resolveListeners: ResolveListener[] = [];

	private readonly pi: ExtensionAPI;
	private readonly config: QuietAskConfig;

	constructor(pi: ExtensionAPI, config: QuietAskConfig) {
		this.pi = pi;
		this.config = config;
	}

	/** Observe every record (the evidence ledger uses this). Listener errors are swallowed. */
	onRecord(listener: RecordListener): void {
		this.recordListeners.push(listener);
	}

	onResolve(listener: ResolveListener): void {
		this.resolveListeners.push(listener);
	}

	record(ctx: ExtensionContext, record: Omit<DecisionRecord, "at" | "sessionId">): DecisionRecord {
		const full: DecisionRecord = {
			at: new Date().toISOString(),
			sessionId: ctx.sessionManager.getSessionId(),
			...record,
		};
		if (!this.config.history.keepState) delete full.state;
		this.pi.appendEntry(DECISION_ENTRY, full);
		this.appendFile(full);
		if (full.toolCallId) this.byToolCall.set(full.toolCallId, full);
		this.recent.push(full);
		if (this.recent.length > 200) this.recent.shift();
		for (const listener of this.recordListeners) {
			try {
				listener(full);
			} catch {
				// A listener must never break recording.
			}
		}
		return full;
	}

	/** Attach an outcome to an earlier record and re-append so the log stays append-only. */
	resolve(toolCallId: string, outcome: DecisionOutcome): DecisionRecord | undefined {
		const record = this.byToolCall.get(toolCallId);
		if (!record) return undefined;
		record.outcome = outcome;
		this.pi.appendEntry(`${DECISION_ENTRY}:outcome`, { toolCallId, outcome });
		this.appendFile({ ...record, action: `${record.action}:resolved` });
		for (const listener of this.resolveListeners) {
			try {
				listener(record, outcome);
			} catch {
				// see above
			}
		}
		return record;
	}

	private appendFile(record: DecisionRecord): void {
		if (!this.config.history.file) return;
		try {
			const path = historyFilePath();
			mkdirSync(dirname(path), { recursive: true });
			appendFileSync(path, `${JSON.stringify(record)}\n`);
		} catch {
			// History must never break the agent.
		}
	}
}

/** Read this branch's decision records from the session, oldest first. */
export function branchDecisions(ctx: ExtensionContext): DecisionRecord[] {
	const records: DecisionRecord[] = [];
	const byToolCall = new Map<string, DecisionRecord>();
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom") continue;
		if (entry.customType === DECISION_ENTRY) {
			const record = entry.data as DecisionRecord;
			records.push(record);
			if (record.toolCallId) byToolCall.set(record.toolCallId, record);
		} else if (entry.customType === `${DECISION_ENTRY}:outcome`) {
			const { toolCallId, outcome } = entry.data as { toolCallId: string; outcome: DecisionOutcome };
			const target = byToolCall.get(toolCallId);
			if (target) target.outcome = outcome;
		}
	}
	return records;
}

function shortTime(iso: string): string {
	return iso.slice(11, 19);
}

export function formatRecordLine(record: DecisionRecord): string {
	const outcome = record.outcome ? (record.outcome.agreed === undefined ? " ✓" : record.outcome.agreed ? " ✓ agreed" : " ✗ overridden") : "";
	return `${shortTime(record.at)} ${record.kind.padEnd(13)} ${record.action.padEnd(10)} ${record.summary}${outcome}`;
}

function formatAnswer(id: string, answer: unknown): string {
	if (!answer || typeof answer !== "object") return `  ${id}: ${String(answer)}`;
	const a = answer as Record<string, unknown>;
	if (a.type === "noul") return `  ${id} (noul): ${Number(a.noul).toFixed(2)}`;
	if (a.type === "choice") {
		const probs = Object.entries((a.probabilities ?? {}) as Record<string, number>)
			.sort((x, y) => y[1] - x[1])
			.map(([k, v]) => `${k}=${v.toFixed(2)}`)
			.join(" ");
		return `  ${id} (choice): ${String(a.choice)} conf=${Number(a.confidence).toFixed(2)} [${probs}]`;
	}
	if (a.type === "score") return `  ${id} (score): ${Number(a.score).toFixed(2)} conf=${Number(a.confidence).toFixed(2)}`;
	return `  ${id}: ${JSON.stringify(answer)}`;
}

export function formatRecord(record: DecisionRecord): string {
	const lines = [
		`${record.kind} · ${record.action} · ${record.mode} · ${record.cached ? "cached" : `${record.latencyMs.toFixed(0)}ms`}`,
		`at: ${record.at}`,
		record.tool ? `tool: ${record.tool}` : undefined,
		record.toolCallId ? `toolCallId: ${record.toolCallId}` : undefined,
		record.summary,
		"answers:",
		...Object.entries(record.answers).map(([id, answer]) => formatAnswer(id, answer)),
	];
	if (record.outcome) {
		lines.push(`outcome (${record.outcome.at}): ${record.outcome.description}`);
	}
	if (record.state !== undefined) {
		const json = JSON.stringify(record.state, null, 2);
		lines.push("state (as sent):", json.length > 1500 ? `${json.slice(0, 1500)}…` : json);
	}
	return lines.filter((line): line is string => line !== undefined).join("\n");
}

/** `/quiet history`: pick a record from this branch and print it. */
export async function showHistory(ctx: ExtensionCommandContext, filter?: DecisionKind): Promise<void> {
	let records = branchDecisions(ctx);
	if (filter) records = records.filter((r) => r.kind === filter);
	if (records.length === 0) {
		ctx.ui.notify(`pi-quiet-ask: no ${filter ?? ""} decisions on this branch yet. File: ${historyFilePath()}`, "info");
		return;
	}
	const newestFirst = [...records].reverse().slice(0, 40);
	const labels = newestFirst.map((r) => formatRecordLine(r));
	const picked = await ctx.ui.select(`pi-quiet-ask history (${records.length} on this branch)`, labels);
	if (!picked) return;
	const record = newestFirst[labels.indexOf(picked)];
	if (record) ctx.ui.notify(formatRecord(record), "info");
}
