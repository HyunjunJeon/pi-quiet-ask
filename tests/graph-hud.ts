import assert from "node:assert/strict";
import { test } from "node:test";
import { formatHud, hudPaint, hudRole, type GraphState, type HudTheme, type Phase } from "../extensions/quiet-ask/graph.ts";

function empty(): GraphState {
	const visits = Object.fromEntries(
		["clarify", "explore", "plan", "implement", "verify", "report", "other"].map((p) => [p, 0]),
	) as Record<Phase, number>;
	return { startedAt: "t", turns: [], visits, edges: {}, fired: [] };
}

test("empty graph still draws the six-phase skeleton", () => {
	const lines = formatHud(empty());
	assert.equal(lines.length, 4);
	assert.match(lines[1] ?? "", /clarify.*explore.*plan.*implement.*verify.*report/);
	assert.match(lines[1] ?? "", /──/);
	assert.equal(lines[3], "waiting for first turn");
	assert.doesNotMatch(lines.join("\n"), /╔/);
});

test("current phase is the double box and visited phases keep a mark", () => {
	const graph = empty();
	graph.visits.implement = 1;
	graph.visits.verify = 0;
	graph.turns.push({
		turn: 0,
		phase: "implement",
		confidence: 0.9,
		progress: 0.8,
		drift: 0.1,
		tools: ["write"],
	});
	const lines = formatHud(graph);
	assert.match(lines[0] ?? "", /╔═+╗/);
	assert.match(lines[1] ?? "", /║implement║/);
	assert.match(lines[2] ?? "", /╚═*●═*╝/);
	assert.match(lines[3] ?? "", /path implement/);
	assert.doesNotMatch(lines[1] ?? "", /║ verify  ║/);
});

test("fired invariant is printed on the stats line", () => {
	const graph = empty();
	graph.visits.implement = 1;
	graph.visits.report = 1;
	graph.turns.push(
		{ turn: 0, phase: "implement", confidence: 1, progress: 1, drift: 0, tools: ["write"] },
		{ turn: 1, phase: "report", confidence: 1, progress: 0.2, drift: 0.1, tools: [] },
	);
	graph.fired.push({ name: "report_without_verify", turn: 1 });
	const text = formatHud(graph).join("\n");
	assert.match(text, /⚠ report_without_verify/);
	assert.match(text, /║ report  ║/);
});

test("roles: current is red-path, visited is passed, unseen is ahead", () => {
	assert.equal(hudRole("implement", "implement", 1), "current");
	assert.equal(hudRole("explore", "implement", 1), "passed");
	assert.equal(hudRole("verify", "report", 0), "ahead");
});

test("paint wraps current in error and passed in strikethrough", () => {
	const theme: HudTheme = {
		fg: (color, text) => `[${color}]${text}[/${color}]`,
		bold: (text) => `*${text}*`,
		strikethrough: (text) => `~${text}~`,
	};
	const graph = empty();
	graph.visits.explore = 1;
	graph.visits.implement = 1;
	graph.turns.push({ turn: 0, phase: "explore", confidence: 1, progress: 1, drift: 0, tools: [] });
	graph.turns.push({ turn: 1, phase: "implement", confidence: 1, progress: 1, drift: 0, tools: ["write"] });
	const mid = formatHud(graph, hudPaint(theme))[1] ?? "";
	assert.match(mid, /\*\[error\].*implement.*\[\/error\]\*/);
	assert.match(mid, /~\[muted\].*explore.*\[\/muted\]~/);
	assert.match(mid, /\[dim\].*verify.*\[\/dim\]/);
});

test("HUD prints previous and current ledger facts, not just a Jev path", () => {
	const graph = empty();
	graph.visits.implement = 1;
	graph.turns.push({ turn: 0, phase: "implement", confidence: 1, progress: 1, drift: 0, tools: ["write"] });
	const lines = formatHud(graph, undefined, {
		prev: "prev verified  implement→verify  ran python3 add.py",
		now: "now  unverified  implement  write hud_check.py",
		session: "session unverified  implement→verify→implement  2 prompts",
	});
	assert.match(lines.join("\n"), /prev verified.*python3 add.py/);
	assert.match(lines.join("\n"), /now  unverified.*hud_check.py/);
	assert.match(lines.join("\n"), /session unverified/);
	assert.doesNotMatch(lines.join("\n"), /progress ▇/);
});
