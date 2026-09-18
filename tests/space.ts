import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildSpace,
	NONE,
	pathsFromArguments,
	suggestedChecks,
	unverifiedFiles,
	type SpaceFacts,
} from "../extensions/quiet-ask/space.ts";

const hello = {
	files_changed: [{ path: "hello.py" }, { path: "tests/test_hello.py" }],
	commands: [
		{ command: "python3 hello.py", kind: "run", is_error: false },
		{ command: "python3 -m pytest -q", kind: "test", is_error: true },
	],
	verifications: [
		{ command: "python3 hello.py", kind: "run", passed: true, after_last_change: false },
		{ command: "python3 -m pytest -q", kind: "test", passed: false, after_last_change: true },
	],
} satisfies SpaceFacts;

test("unverified files empty only after a passing current check", () => {
	assert.deepEqual(unverifiedFiles(hello), ["hello.py", "tests/test_hello.py"]);
	assert.deepEqual(
		unverifiedFiles({
			...hello,
			verifications: [{ command: "python3 -m pytest -q", kind: "test", passed: true, after_last_change: true }],
		}),
		[],
	);
});

test("verify_targets numbers observed files and checks, plus none", () => {
	const space = buildSpace("verify_targets", hello);
	assert.deepEqual(
		space.options.map((o) => o.id),
		["f1", "f2", "c1", "c2"],
	);
	assert.equal(space.byId.get("f1")?.value, "hello.py");
	assert.equal(space.byId.get("c2")?.value, "python3 -m pytest -q");
	assert.ok(NONE in space.criteria);
	assert.equal(space.options.some((o) => o.id === "invented"), false);
});

test("recent_failures only lists commands that errored", () => {
	const space = buildSpace("recent_failures", hello);
	assert.deepEqual(
		space.options.map((o) => o.value),
		["python3 -m pytest -q"],
	);
});

test("argument_paths never invents a path the call did not name", () => {
	assert.deepEqual(pathsFromArguments({ path: "src/app.ts" }), ["src/app.ts"]);
	assert.deepEqual(pathsFromArguments({ command: "rm -rf ../other-repo/secrets.env" }), ["../other-repo/secrets.env"]);
	assert.deepEqual(pathsFromArguments({ command: "ls" }), []);
	const space = buildSpace("argument_paths", { arguments: { path: "src/app.ts" } });
	assert.equal(space.byId.get("p1")?.value, "src/app.ts");
	assert.equal(space.byId.has("p2"), false);
});

test("suggestedChecks keeps stale and failed verifications", () => {
	assert.ok(suggestedChecks(hello).includes("python3 hello.py"));
	assert.ok(suggestedChecks(hello).includes("python3 -m pytest -q"));
});
