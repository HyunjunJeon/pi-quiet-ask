import assert from "node:assert/strict";
import { test } from "node:test";
import { assessMove } from "../extensions/quiet-ask/evidence.ts";

test("implement→report with no check is skip", () => {
	const r = assessMove({
		from: "implement",
		to: "report",
		progress: 0.2,
		drift: 0.1,
		tools: ["write"],
		files: ["add.py"],
		checks: [],
		invariants: ["report_without_verify"],
	});
	assert.equal(r.fit, "skip");
	assert.match(r.reason, /without a check/);
});

test("same cell and low progress is loop", () => {
	const r = assessMove({
		from: "explore",
		to: "explore",
		progress: 0.2,
		drift: 0.1,
		tools: ["read"],
		files: [],
		checks: [],
		invariants: [],
	});
	assert.equal(r.fit, "loop");
});

test("high drift is drift", () => {
	const r = assessMove({
		from: "implement",
		to: "implement",
		progress: 0.8,
		drift: 0.91,
		tools: ["write"],
		files: ["other.py"],
		checks: [],
		invariants: [],
	});
	assert.equal(r.fit, "drift");
});

test("write during report is mismatch", () => {
	const r = assessMove({
		from: "implement",
		to: "report",
		progress: 0.5,
		drift: 0.1,
		tools: ["write"],
		files: ["x.py"],
		checks: ["python3 x.py"],
		invariants: [],
	});
	assert.equal(r.fit, "mismatch");
});

test("implement then verify is ok", () => {
	const r = assessMove({
		from: "implement",
		to: "verify",
		progress: 0.9,
		drift: 0.05,
		tools: ["bash"],
		files: [],
		checks: ["python3 add.py"],
		invariants: [],
	});
	assert.equal(r.fit, "ok");
	assert.equal(r.reason, "implement→verify");
});
