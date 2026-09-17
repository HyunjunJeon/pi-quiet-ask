/* Offline: the evidence ledger with a fake pi and history store. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../extensions/quiet-ask/config.ts";
import { classifyCommand, deriveStatus, EVIDENCE_SCHEMA_URL, EvidenceStore } from "../extensions/quiet-ask/evidence.ts";
import { HistoryStore } from "../extensions/quiet-ask/history.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakePi() {
	const handlers: Record<string, Handler[]> = {};
	return {
		handlers,
		on(event: string, handler: Handler) {
			(handlers[event] ??= []).push(handler);
		},
		appendEntry() {},
		async fire(event: string, payload: unknown, ctx: unknown) {
			for (const h of handlers[event] ?? []) await h(payload, ctx);
		},
	};
}

function ctxFor(cwd = "/tmp/proj", sessionId = "sess-1") {
	return { cwd, hasUI: false, sessionManager: { getBranch: () => [], getSessionId: () => sessionId }, ui: { notify() {} } } as never;
}

test("classifyCommand picks the checking kind", () => {
	assert.equal(classifyCommand("npm test"), "test");
	assert.equal(classifyCommand("pnpm run test -- --watch=false"), "test");
	assert.equal(classifyCommand("npx tsc --noEmit -p tsconfig.json"), "typecheck");
	assert.equal(classifyCommand("uv run ruff check src"), "lint");
	assert.equal(classifyCommand("cargo build --release"), "build");
	assert.equal(classifyCommand("python3 hello.py"), "run");
	assert.equal(classifyCommand("git status --short"), "other");
	assert.equal(classifyCommand("cat .env"), "other");
});

test("ledger: files, commands, verification freshness, status, JSON file", async () => {
	const dir = mkdtempSync(join(tmpdir(), "qa-evidence-"));
	const pi = fakePi();
	const config = structuredClone(DEFAULT_CONFIG);
	config.history.file = false;
	config.evidence.dir = dir;
	const history = new HistoryStore(pi as never, config);
	const store = new EvidenceStore(pi as never, config, (t) => t);
	const ctx = ctxFor();
	store.register(history, ctx);
	assert.equal(store.filePath(), join(dir, "sess-1.json"));

	await pi.fire("input", { type: "input", text: "add a helper and test it", source: "interactive" }, ctx);
	await pi.fire("before_agent_start", { type: "before_agent_start", prompt: "add a helper and test it" }, ctx);
	history.record(ctx, { kind: "intent", action: "small_edit", summary: "", answers: { intent: { type: "choice", choice: "small_edit", confidence: 0.8 } }, latencyMs: 1, cached: false, mode: "shadow" });
	assert.deepEqual(store.current().intent, { label: "small_edit", confidence: 0.8 });
	assert.equal(store.current().status, "no_changes");

	await pi.fire("turn_start", { type: "turn_start", turnIndex: 0 }, ctx);
	await pi.fire("tool_result", { type: "tool_result", toolName: "write", input: { path: "util.py" }, isError: false, content: [] }, ctx);
	assert.equal(store.current().status, "in_progress");
	assert.equal(store.snapshot().facts.verified_after_change, false);

	await pi.fire("turn_start", { type: "turn_start", turnIndex: 1 }, ctx);
	await pi.fire("tool_result", { type: "tool_result", toolName: "bash", input: { command: "python3 -m pytest -q" }, isError: false, content: [{ type: "text", text: "3 passed" }] }, ctx);
	assert.equal(store.current().status, "verified");
	assert.equal(store.snapshot().facts.verified_after_change, true);
	assert.equal(store.current().verifications[0].kind, "test");
	assert.equal(store.current().verifications[0].turn, 1);

	await pi.fire("tool_result", { type: "tool_result", toolName: "edit", input: { path: "util.py" }, isError: false, content: [] }, ctx);
	assert.equal(store.current().verifications[0].after_last_change, false);
	assert.equal(store.current().status, "in_progress");

	await pi.fire("agent_end", { type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "Done, all good." }] }] }, ctx);
	assert.equal(store.current().status, "unverified", "run ended after an unverified change");
	assert.equal(store.current().runs[0].final_text, "Done, all good.");

	history.record(ctx, {
		kind: "honest_finish",
		action: "steer",
		summary: "",
		answers: { claims_done: { type: "noul", noul: 0.95 }, verified: { type: "noul", noul: 0.1 }, hedged: { type: "noul", noul: 0.05 } },
		latencyMs: 1,
		cached: false,
		mode: "enforce",
	});
	assert.equal(store.current().runs[0].claims_done, 0.95);
	assert.equal(store.current().decisions.at(-1)?.action, "steer");

	history.record(ctx, { kind: "triage", toolCallId: "tc9", tool: "ask_user", action: "auto", summary: "pm → pnpm", answers: {}, latencyMs: 1, cached: false, mode: "auto" });
	history.resolve("tc9", { at: "", description: "final: pm=pnpm", agreed: true });
	const decision = store.current().decisions.find((d) => d.toolCallId === "tc9")!;
	assert.equal(decision.outcome, "final: pm=pnpm");
	assert.equal(decision.agreed, true);

	history.record(ctx, { kind: "force_push", toolCallId: "tc10", tool: "bash", action: "block", summary: "git push --force", answers: {}, latencyMs: 1, cached: false, mode: "enforce" });
	assert.equal(store.current().status, "blocked");

	history.record(ctx, { kind: "gate", action: "pass", summary: "", answers: {}, latencyMs: 1, cached: false, mode: "shadow" });
	assert.equal(store.current().decisions.filter((d) => d.action === "pass").length, 0);
	store.addPhase({ turn: 0, phase: "implement", confidence: 0.9, progress: 0.8, drift: 0.1, tools: ["write"] }, ["report_without_verify"]);
	assert.deepEqual(store.current().invariants, [{ name: "report_without_verify", turn: 0 }]);

	await pi.fire("input", { type: "input", text: "now document it", source: "interactive" }, ctx);
	assert.equal(store.file.prompts.length, 2);
	assert.equal(store.current().status, "no_changes");

	assert.ok(existsSync(store.filePath()!));
	const onDisk = JSON.parse(readFileSync(store.filePath()!, "utf8"));
	assert.equal(onDisk.$schema, EVIDENCE_SCHEMA_URL);
	assert.equal(onDisk.version, 1);
	assert.equal(onDisk.session_id, "sess-1");
	assert.equal(onDisk.prompts.length, 2);
	assert.equal(onDisk.prompts[0].files_changed.length, 2);
	assert.equal(onDisk.prompts[0].phases[0].phase, "implement");
	assert.equal(onDisk.prompts[1].request, "now document it");
});

test("bind reloads an existing session ledger", () => {
	const dir = mkdtempSync(join(tmpdir(), "qa-evidence-"));
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "sess-resume.json"),
		JSON.stringify({
			version: 1,
			session_id: "sess-resume",
			cwd: "/old",
			updated_at: "2026-09-17T00:00:00.000Z",
			prompts: [
				{
					index: 1,
					started_at: "2026-09-17T00:00:00.000Z",
					request: "previous work",
					files_changed: [],
					commands: [],
					verifications: [],
					phases: [],
					invariants: [],
					runs: [],
					decisions: [],
					status: "no_changes",
				},
			],
		}),
	);
	const pi = fakePi();
	const config = structuredClone(DEFAULT_CONFIG);
	config.history.file = false;
	config.evidence.dir = dir;
	const store = new EvidenceStore(pi as never, config, (t) => t);
	store.bind(ctxFor("/tmp/proj", "sess-resume"));
	assert.equal(store.file.prompts.length, 1);
	assert.equal(store.current().request, "previous work");
});

test("bind ignores a corrupt ledger instead of throwing", () => {
	const dir = mkdtempSync(join(tmpdir(), "qa-evidence-"));
	writeFileSync(join(dir, "sess-bad.json"), "{not json");
	const config = structuredClone(DEFAULT_CONFIG);
	config.history.file = false;
	config.evidence.dir = dir;
	const store = new EvidenceStore(fakePi() as never, config, (t) => t);
	store.bind(ctxFor("/tmp/proj", "sess-bad"));
	assert.equal(store.file.prompts.length, 0);
});

test("deriveStatus", () => {
	const base = { index: 1, started_at: "", request: "", files_changed: [], commands: [], verifications: [], phases: [], invariants: [], runs: [], decisions: [], status: "no_changes" as const };
	assert.equal(deriveStatus(base), "no_changes");
	const changed = { ...base, files_changed: [{ at: "", run: 1, turn: 0, tool: "write" as const, path: "a", is_error: false }] };
	assert.equal(deriveStatus(changed), "in_progress");
	assert.equal(deriveStatus({ ...changed, runs: [{ ended_at: "", final_text: "", tool_count: 1 }] }), "unverified");
	const v = { at: "", run: 1, turn: 1, command: "npm test", kind: "test" as const, is_error: false, output_head: "", after_last_change: true, passed: true };
	assert.equal(deriveStatus({ ...changed, verifications: [v] }), "verified");
	assert.equal(deriveStatus({ ...changed, verifications: [{ ...v, passed: false }] }), "in_progress");
});
