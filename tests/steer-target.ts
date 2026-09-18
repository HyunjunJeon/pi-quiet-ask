/**
 * Old (0.2 generic) vs new (observed-target) steer wording.
 *
 * This is the product difference: the agent used to hear "run the relevant
 * check". It now hears the ledger member Jev picked, or the old sentence
 * when the space is empty / the id was invented.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { consumeTarget } from "../extensions/quiet-ask/choice.ts";
import { buildSpace, type ObservedOption, type SpaceFacts } from "../extensions/quiet-ask/space.ts";
import {
	GENERIC_HONEST_FINISH,
	GENERIC_INVARIANT_STEER,
	GENERIC_STUCK_LOOP,
	renderHonestFinishSteer,
	renderInvariantSteer,
	renderStuckLoopSteer,
} from "../extensions/quiet-ask/steer.ts";

const facts: SpaceFacts = {
	files_changed: [{ path: "extensions/quiet-ask/evidence.ts" }],
	commands: [{ command: "npm run check", kind: "typecheck", is_error: false }],
	verifications: [{ command: "npm run check", kind: "typecheck", passed: true, after_last_change: false }],
};

const space = buildSpace("verify_targets", facts);
const file = space.byId.get("f1")!;
const check = space.byId.get("c1")!;
const failure: ObservedOption = {
	id: "c1",
	kind: "failure",
	label: "pytest",
	value: "python3 -m pytest -q",
	description: "failed",
};

const COMPARISONS = [
	{
		kind: "graph/report_without_verify",
		old: GENERIC_INVARIANT_STEER.report_without_verify,
		next: renderInvariantSteer("report_without_verify", check),
		needle: /npm run check/,
	},
	{
		kind: "honest_finish",
		old: GENERIC_HONEST_FINISH,
		next: renderHonestFinishSteer(file),
		needle: /evidence\.ts/,
	},
	{
		kind: "stuck/loop",
		old: GENERIC_STUCK_LOOP,
		next: renderStuckLoopSteer(failure),
		needle: /python3 -m pytest -q/,
	},
] as const;

test("targeted steers differ from the 0.2 generic and name the observed member", () => {
	for (const row of COMPARISONS) {
		assert.notEqual(row.next, row.old, `${row.kind}: must differ from the generic`);
		assert.match(row.next, row.needle);
		assert.doesNotMatch(row.old, row.needle);
	}
});

test("empty space or invented id keeps the 0.2 sentence", () => {
	assert.equal(renderInvariantSteer("report_without_verify"), GENERIC_INVARIANT_STEER.report_without_verify);
	assert.equal(renderHonestFinishSteer(), GENERIC_HONEST_FINISH);
	const invented = consumeTarget({ type: "choice", choice: "f99", confidence: 1, probabilities: { f99: 1 } }, space);
	assert.equal(invented, undefined);
	assert.equal(renderInvariantSteer("report_without_verify", invented), GENERIC_INVARIANT_STEER.report_without_verify);
});

test("explore_loop and drift stay generic — no verify target applies", () => {
	assert.equal(renderInvariantSteer("explore_loop", check), GENERIC_INVARIANT_STEER.explore_loop);
	assert.equal(renderInvariantSteer("drift", check), GENERIC_INVARIANT_STEER.drift);
});

test("print old vs new so the difference is visible in the test run", () => {
	const lines = ["", "── old (0.2 generic) vs new (observed target) ──"];
	for (const row of COMPARISONS) {
		lines.push("", `■ ${row.kind}`, `  OLD  ${row.old}`, `  NEW  ${row.next}`);
	}
	console.log(lines.join("\n"));
	assert.equal(COMPARISONS.length, 3);
});
