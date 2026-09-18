/**
 * End-to-end: a ledger with an unverified file, a mocked Jev pick, and
 * the steer / confirm the agent actually receives.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { JevClient } from "../extensions/quiet-ask/client.ts";
import { DEFAULT_CONFIG } from "../extensions/quiet-ask/config.ts";
import { Engine } from "../extensions/quiet-ask/engine/engine.ts";
import { normalizePack } from "../extensions/quiet-ask/engine/pack.ts";
import { EvidenceStore } from "../extensions/quiet-ask/evidence.ts";
import { GraphTracker } from "../extensions/quiet-ask/graph.ts";
import { HistoryStore } from "../extensions/quiet-ask/history.ts";
import { GATE_PACK } from "../extensions/quiet-ask/packs/gate.ts";
import { HONEST_FINISH_PACK } from "../extensions/quiet-ask/packs/honest-finish.ts";
import { createRuntimeSettings } from "../extensions/quiet-ask/settings.ts";
import { buildSpace, type SpaceFacts } from "../extensions/quiet-ask/space.ts";
import { GENERIC_HONEST_FINISH, GENERIC_INVARIANT_STEER } from "../extensions/quiet-ask/steer.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakePi() {
	const handlers: Record<string, Handler[]> = {};
	const messages: { content: string; details?: unknown }[] = [];
	return {
		handlers,
		messages,
		on(event: string, handler: Handler) {
			(handlers[event] ??= []).push(handler);
		},
		appendEntry() {},
		sendMessage(msg: { content: string; details?: unknown }) {
			messages.push(msg);
		},
		setThinkingLevel() {},
		setActiveTools() {},
		async fire(event: string, payload: unknown, ctx: unknown) {
			for (const h of handlers[event] ?? []) await h(payload, ctx);
		},
	};
}

function ctxFor(cwd = "/tmp/proj", sessionId = "sess-obs") {
	return {
		cwd,
		hasUI: false,
		signal: undefined,
		sessionManager: { getBranch: () => [], getSessionId: () => sessionId },
		ui: { notify() {}, setStatus() {}, confirm: async () => true },
	} as never;
}

function noul(value: number) {
	return { type: "noul" as const, noul: value };
}

function choice(selected: string, ids: string[]) {
	const probabilities = Object.fromEntries(ids.map((id) => [id, id === selected ? 0.85 : 0.15 / Math.max(1, ids.length - 1)]));
	return { type: "choice" as const, choice: selected, confidence: 0.8, probabilities };
}

function score(value: number) {
	return { type: "score" as const, score: value, confidence: 0.6, probabilities: {} };
}

function fakeClient(script: Array<Record<string, unknown>> | ((questions: Record<string, unknown>) => Record<string, unknown>)): JevClient & { calls: { questions: Record<string, unknown>; state: unknown }[] } {
	const calls: { questions: Record<string, unknown>; state: unknown }[] = [];
	let i = 0;
	return {
		calls,
		async ask(state: unknown, questions: Record<string, unknown>) {
			calls.push({ questions, state });
			const answers = typeof script === "function" ? script(questions) : Array.isArray(script) ? (script[Math.min(i, script.length - 1)] ?? {}) : script;
			i += 1;
			return { result: { answers, model: "test", usage: {} }, latencyMs: 4, cached: false };
		},
		scrub: (t: string) => t,
	} as never;
}

const ledger: SpaceFacts = {
	files_changed: [{ path: "hello.py" }],
	commands: [{ command: "python3 -m pytest -q", kind: "test", is_error: false }],
	verifications: [{ command: "python3 -m pytest -q", kind: "test", passed: true, after_last_change: false }],
};

test("honest_finish steer names the observed check; invented id keeps the generic", async () => {
	const space = buildSpace("verify_targets", ledger);
	const ids = Object.keys(space.criteria);
	const pack = normalizePack({ ...HONEST_FINISH_PACK, mode: "enforce" }, "builtin");
	const messages = [
		{
			role: "assistant",
			content: [
				{ type: "toolCall", id: "1", name: "write", arguments: { path: "hello.py" } },
				{ type: "text", text: "Done — hello.py is written and works." },
			],
		},
		{ role: "toolResult", toolCallId: "1", isError: false, content: [] },
	];

	const observed = fakeClient({
		claims_done: noul(0.99),
		verified: noul(0.02),
		hedged: noul(0.04),
		verify_target: choice("c1", ids),
	});
	const engineObserved = new Engine(
		{
			pi: fakePi() as never,
			client: observed,
			config: structuredClone(DEFAULT_CONFIG),
			settings: createRuntimeSettings(DEFAULT_CONFIG),
			history: new HistoryStore(fakePi() as never, { ...DEFAULT_CONFIG, history: { file: false, keepState: false } }),
			providers: { evidence: () => ({ state: {}, facts: { files_changed: 1, verifications: 1, verified_after_change: false }, space: ledger }) },
		},
		[pack],
	);
	const hit = await engineObserved.judge(pack, { hook: "agent_end", messages }, ctxFor(), "done");
	assert.ok(hit);
	assert.ok(hit.matched.includes("unverified_claim"));
	const targeted = hit.actions.find((a) => a.do === "steer");
	assert.ok(targeted && targeted.do === "steer");
	assert.match(targeted.say, /python3 -m pytest -q/);
	assert.notEqual(targeted.say, GENERIC_HONEST_FINISH);
	assert.ok("verify_target" in observed.calls[0].questions, "speculative target head must be in the same request");

	const invented = fakeClient({
		claims_done: noul(0.99),
		verified: noul(0.02),
		hedged: noul(0.04),
		verify_target: { type: "choice", choice: "invented", confidence: 1, probabilities: { invented: 1 } },
	});
	const engineInvented = new Engine(
		{
			pi: fakePi() as never,
			client: invented,
			config: structuredClone(DEFAULT_CONFIG),
			settings: createRuntimeSettings(DEFAULT_CONFIG),
			history: new HistoryStore(fakePi() as never, { ...DEFAULT_CONFIG, history: { file: false, keepState: false } }),
			providers: { evidence: () => ({ state: {}, facts: { files_changed: 1, verifications: 1, verified_after_change: false }, space: ledger }) },
		},
		[pack],
	);
	const miss = await engineInvented.judge(pack, { hook: "agent_end", messages }, ctxFor(), "done");
	const fallback = miss?.actions.find((a) => a.do === "steer");
	assert.ok(fallback && fallback.do === "steer");
	assert.equal(fallback.say, GENERIC_HONEST_FINISH);
});

test("graph report_without_verify steers the observed check from the same request", async () => {
	const dir = mkdtempSync(join(tmpdir(), "qa-obs-"));
	const pi = fakePi();
	const config = structuredClone(DEFAULT_CONFIG);
	config.history.file = false;
	config.evidence.dir = dir;
	config.graph.mode = "enforce";
	config.graph.hud = false;
	const history = new HistoryStore(pi as never, config);
	const evidence = new EvidenceStore(pi as never, config, (t) => t);
	const ctx = ctxFor(dir, "sess-graph");
	evidence.register(history, ctx);
	await pi.fire("input", { type: "input", text: "add hello.py and claim it works", source: "interactive" }, ctx);
	await pi.fire("tool_result", { type: "tool_result", toolName: "write", input: { path: "hello.py" }, isError: false, content: [] }, ctx);
	await pi.fire(
		"tool_result",
		{ type: "tool_result", toolName: "bash", input: { command: "python3 -m pytest -q" }, isError: false, content: [{ type: "text", text: "ok" }] },
		ctx,
	);
	await pi.fire("tool_result", { type: "tool_result", toolName: "edit", input: { path: "hello.py" }, isError: false, content: [] }, ctx);

	const space = buildSpace("verify_targets", evidence.snapshot().space);
	const ids = Object.keys(space.criteria);
	let judged = 0;
	const client = fakeClient((questions) => {
		const phase = judged === 0 ? "implement" : "report";
		judged += 1;
		const hasTarget = "verify_target" in questions;
		return {
			phase: choice(phase, ["clarify", "explore", "plan", "implement", "verify", "report", "other"]),
			progress: noul(0.8),
			drift: noul(0.1),
			...(hasTarget ? { verify_target: choice("c1", ids) } : {}),
		};
	});
	const settings = createRuntimeSettings(config);
	const graph = new GraphTracker(pi as never, client, config, settings, history, evidence);
	graph.register();

	const turn = (index: number, text: string) => ({
		type: "turn_end",
		turnIndex: index,
		message: { role: "assistant", content: [{ type: "text", text }] },
		toolResults: [],
	});
	await pi.fire("turn_end", turn(0, "wrote hello.py"), ctx);
	await pi.fire("turn_end", turn(1, "done, it works"), ctx);

	assert.equal(pi.messages.length, 1);
	assert.match(pi.messages[0].content, /python3 -m pytest -q/);
	assert.doesNotMatch(pi.messages[0].content, new RegExp(GENERIC_INVARIANT_STEER.report_without_verify.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.ok(client.calls.some((c) => "verify_target" in c.questions));
	assert.ok(client.calls.every((c) => "phase" in c.questions), "target head is speculative: phase is always asked");
});

test("gate confirm appends the observed path; invented path is ignored", async () => {
	const pack = normalizePack({ ...GATE_PACK, mode: "enforce" }, "builtin");
	const args = { command: "cat ../other-repo/secrets.env" };
	const space = buildSpace("argument_paths", { arguments: args });
	const ids = Object.keys(space.criteria);

	const observed = fakeClient({
		destructive: noul(0.2),
		exfiltration: noul(0.2),
		beyond_scope: noul(0.92),
		impact: score(1),
		affected_path: choice("p1", ids),
	});
	const engine = new Engine(
		{
			pi: fakePi() as never,
			client: observed,
			config: structuredClone(DEFAULT_CONFIG),
			settings: createRuntimeSettings(DEFAULT_CONFIG),
			history: new HistoryStore(fakePi() as never, { ...DEFAULT_CONFIG, history: { file: false, keepState: false } }),
			providers: { evidence: () => ({ state: {}, facts: { files_changed: 0, verifications: 0, verified_after_change: false }, space: {} }) },
		},
		[pack],
	);
	const hit = await engine.judge(pack, { hook: "tool_call", tool: "bash", arguments: args }, ctxFor(), "cat secrets");
	const confirm = hit?.actions.find((a) => a.do === "confirm");
	assert.ok(confirm && confirm.do === "confirm");
	assert.match(confirm.say ?? "", /other-repo\/secrets\.env/);

	const invented = fakeClient({
		destructive: noul(0.2),
		exfiltration: noul(0.2),
		beyond_scope: noul(0.92),
		impact: score(1),
		affected_path: { type: "choice", choice: "p99", confidence: 1, probabilities: { p99: 1 } },
	});
	const engine2 = new Engine(
		{
			pi: fakePi() as never,
			client: invented,
			config: structuredClone(DEFAULT_CONFIG),
			settings: createRuntimeSettings(DEFAULT_CONFIG),
			history: new HistoryStore(fakePi() as never, { ...DEFAULT_CONFIG, history: { file: false, keepState: false } }),
			providers: { evidence: () => ({ state: {}, facts: { files_changed: 0, verifications: 0, verified_after_change: false }, space: {} }) },
		},
		[pack],
	);
	const miss = await engine2.judge(pack, { hook: "tool_call", tool: "bash", arguments: args }, ctxFor(), "cat secrets");
	const plain = miss?.actions.find((a) => a.do === "confirm");
	assert.ok(plain && plain.do === "confirm");
	assert.doesNotMatch(plain.say ?? "", /p99/);
	assert.doesNotMatch(plain.say ?? "", /invented/);
});
