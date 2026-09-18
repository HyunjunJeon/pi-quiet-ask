import assert from "node:assert/strict";
import { test } from "node:test";
import { consumeTarget, validateChoice } from "../extensions/quiet-ask/choice.ts";
import { buildSpace, type SpaceFacts } from "../extensions/quiet-ask/space.ts";

const ids = ["f1", "c1", "none"];

function choice(selected: string, extras: Record<string, unknown> = {}) {
	const probabilities = Object.fromEntries(ids.map((id) => [id, id === selected ? 0.8 : 0.1]));
	return { type: "choice", choice: selected, confidence: 0.7, probabilities, ...extras };
}

test("validateChoice accepts a member of the offered set", () => {
	const ok = validateChoice(choice("f1"), ids);
	assert.equal(ok?.choice, "f1");
});

test("invented id is rejected — no action from a hallucinated member", () => {
	assert.equal(validateChoice({ ...choice("f1"), choice: "invented" }, ids), undefined);
	assert.equal(validateChoice(choice("f1"), ["none"]), undefined);
});

test("non-max choice is rejected", () => {
	assert.equal(validateChoice(choice("c1", { probabilities: { f1: 0.9, c1: 0.05, none: 0.05 } }), ids), undefined);
});

test("NaN / out-of-range probabilities are rejected", () => {
	assert.equal(validateChoice(choice("f1", { probabilities: { f1: Number.NaN, c1: 0, none: 0 } }), ids), undefined);
	assert.equal(validateChoice(choice("f1", { probabilities: { f1: 1.2, c1: 0, none: 0 } }), ids), undefined);
});

test("consumeTarget returns the observed option and ignores none / invented", () => {
	const facts: SpaceFacts = { files_changed: [{ path: "hello.py" }] };
	const space = buildSpace("unverified_files", facts);
	assert.equal(consumeTarget(choice("f1", { probabilities: { f1: 1, none: 0 } }), space)?.value, "hello.py");
	assert.equal(consumeTarget(choice("none", { probabilities: { f1: 0, none: 1 } }), space), undefined);
	assert.equal(consumeTarget({ type: "choice", choice: "f99", confidence: 1, probabilities: { f99: 1 } }, space), undefined);
});
