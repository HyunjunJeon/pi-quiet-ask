/**
 * Packs: the declarative unit of the rule engine.
 *
 * A pack says *when* to judge (a pi hook plus a filter), *what* to send
 * (named state sources), *what to ask* Jev (typed questions), and *what to
 * do* with the numbers (ordered rules whose conditions are `expr.ts`
 * expressions and whose actions come from a closed vocabulary).
 *
 * Built-in packs are TypeScript objects in `../packs/`; user packs are JSON
 * files in `~/.pi/agent/pi-quiet-ask/packs/` or `<project>/.pi/pi-quiet-ask/packs/`,
 * or inline under `packs.<name>` in the config. Both go through the same
 * `normalizePack`, so a user can copy a built-in, edit a threshold, and
 * drop it in.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type ChoiceCriteria, choice, noul, type Questions, type ScoreCriteria, score } from "@typesafe-ai/sdk";
import { type Expr, ExprError, parseExpr } from "./expr.ts";

export type Hook = "tool_call" | "tool_result" | "before_agent_start" | "turn_end" | "agent_end";
export type PackMode = "shadow" | "enforce";

export const STATE_SOURCES = [
	"cwd",
	"user_request",
	"last_user_message",
	"recent_turns",
	"tool",
	"arguments",
	"output",
	"is_error",
	"prompt",
	"assistant_text",
	"turn_tools",
	"run_tools",
	"recent_failures",
	"turn_index",
	"graph",
	"evidence",
] as const;
export type StateSource = (typeof STATE_SOURCES)[number];

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Closed action vocabulary. Jev returns numbers; these are the only verbs. */
export type Action =
	| { do: "allow" }
	| { do: "block"; say?: string }
	| { do: "confirm"; say?: string }
	| { do: "warn"; say: string }
	| { do: "annotate"; say: string }
	| { do: "steer"; say: string; maxPerPrompt?: number }
	| { do: "set_thinking"; level: ThinkingLevel }
	| { do: "set_tools"; tools: string[] }
	| { do: "status"; say: string }
	| { do: "tag"; label: string };

/** Actions that change what the agent does; shadow mode downgrades them to warnings. */
export const INTERVENING: ReadonlySet<Action["do"]> = new Set(["block", "confirm", "steer", "set_thinking", "set_tools"]);

const ACTIONS_BY_HOOK: Record<Hook, ReadonlySet<Action["do"]>> = {
	tool_call: new Set(["allow", "block", "confirm", "warn", "status", "tag", "set_tools"]),
	tool_result: new Set(["allow", "annotate", "warn", "status", "tag"]),
	before_agent_start: new Set(["allow", "warn", "status", "tag", "set_thinking", "set_tools"]),
	turn_end: new Set(["allow", "warn", "steer", "status", "tag", "set_thinking"]),
	agent_end: new Set(["allow", "warn", "steer", "status", "tag"]),
};

export interface When {
	tool?: string[];
	is_error?: boolean;
	/** turn_end only: skip early turns. */
	min_turn_index?: number;
	/** turn_end only: only judge turns that contain at least one failed tool call. */
	has_error?: boolean;
	/** tool_result only: skip tiny outputs. */
	min_output_chars?: number;
}

export interface RuleSpec {
	name?: string;
	if: string;
	then: Action | Action[];
}

export interface CompiledRule {
	name: string;
	source: string;
	expr: Expr;
	actions: Action[];
}

/** JSON-facing question spec: exactly one of noul / choice / score. */
export type QuestionSpec =
	| { noul: string }
	| { choice: string; options: Record<string, string | null> }
	| { score: string; levels: string[] };

export interface PackSpec {
	name: string;
	description?: string;
	on: Hook;
	when?: When;
	mode?: PackMode;
	enabled?: boolean;
	state: StateSource[];
	cacheSeconds?: number;
	vars?: Record<string, number | string | boolean>;
	questions: Record<string, QuestionSpec>;
	rules: RuleSpec[];
	/** Template for the one-line history summary. */
	summary?: string;
	/** Footer status template, rendered after every judgement regardless of rules. */
	status?: string;
}

export interface Pack {
	name: string;
	description: string;
	on: Hook;
	when: When;
	mode: PackMode;
	enabled: boolean;
	state: StateSource[];
	cacheSeconds: number;
	vars: Record<string, number | string | boolean>;
	questions: Questions;
	questionSpecs: Record<string, QuestionSpec>;
	rules: CompiledRule[];
	summary: string | undefined;
	status: string | undefined;
	origin: "builtin" | "user" | "project" | "config";
}

/** Partial overrides allowed under `packs.<name>` in the config. */
export interface PackOverride {
	enabled?: boolean;
	mode?: PackMode;
	cacheSeconds?: number;
	vars?: Record<string, number | string | boolean>;
	when?: When;
}

export class PackError extends Error {}

function toQuestions(specs: Record<string, QuestionSpec>, pack: string): Questions {
	const out: Questions = {};
	for (const [id, spec] of Object.entries(specs)) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(id)) throw new PackError(`${pack}: question id "${id}" must be an identifier`);
		if ("noul" in spec) out[id] = noul(spec.noul);
		else if ("choice" in spec) {
			if (!spec.options || Object.keys(spec.options).length < 2) throw new PackError(`${pack}: choice "${id}" needs 2+ options`);
			out[id] = choice(spec.choice, spec.options as ChoiceCriteria);
		} else if ("score" in spec) {
			if (!spec.levels || spec.levels.length < 2) throw new PackError(`${pack}: score "${id}" needs 2+ levels`);
			out[id] = score(spec.score, spec.levels as unknown as ScoreCriteria);
		} else throw new PackError(`${pack}: question "${id}" must have noul, choice, or score`);
	}
	return out;
}

function compileRules(rules: RuleSpec[], hook: Hook, pack: string): CompiledRule[] {
	return rules.map((rule, index) => {
		const name = rule.name ?? `rule${index + 1}`;
		if (typeof rule.if !== "string") throw new PackError(`${pack}: rule "${name}" needs an "if" expression`);
		let expr: Expr;
		try {
			expr = parseExpr(rule.if);
		} catch (error) {
			throw new PackError(`${pack}: rule "${name}": ${error instanceof ExprError ? error.message : String(error)}`);
		}
		const actions = Array.isArray(rule.then) ? rule.then : [rule.then];
		if (actions.length === 0) throw new PackError(`${pack}: rule "${name}" has no actions`);
		for (const action of actions) {
			if (!action || typeof action.do !== "string") throw new PackError(`${pack}: rule "${name}" has a malformed action`);
			if (!ACTIONS_BY_HOOK[hook].has(action.do)) throw new PackError(`${pack}: action "${action.do}" is not allowed on ${hook}`);
		}
		return { name, source: rule.if, expr, actions };
	});
}

export function normalizePack(spec: PackSpec, origin: Pack["origin"], override?: PackOverride): Pack {
	if (!spec || typeof spec.name !== "string" || !spec.name) throw new PackError("pack needs a name");
	if (!(spec.on in ACTIONS_BY_HOOK)) throw new PackError(`${spec.name}: unknown hook "${String(spec.on)}"`);
	if (!Array.isArray(spec.state)) throw new PackError(`${spec.name}: "state" must be a list of sources`);
	for (const source of spec.state) {
		if (!STATE_SOURCES.includes(source)) throw new PackError(`${spec.name}: unknown state source "${source}"`);
	}
	if (!spec.questions || Object.keys(spec.questions).length === 0) throw new PackError(`${spec.name}: needs at least one question`);
	if (!Array.isArray(spec.rules)) throw new PackError(`${spec.name}: "rules" must be a list`);

	return {
		name: spec.name,
		description: spec.description ?? "",
		on: spec.on,
		when: { ...(spec.when ?? {}), ...(override?.when ?? {}) },
		mode: override?.mode ?? spec.mode ?? "shadow",
		enabled: override?.enabled ?? spec.enabled ?? true,
		state: spec.state,
		cacheSeconds: override?.cacheSeconds ?? spec.cacheSeconds ?? 0,
		vars: { ...(spec.vars ?? {}), ...(override?.vars ?? {}) },
		questions: toQuestions(spec.questions, spec.name),
		questionSpecs: spec.questions,
		rules: compileRules(spec.rules, spec.on, spec.name),
		summary: spec.summary,
		status: spec.status,
		origin,
	};
}

/** A config entry is a full pack when it carries `on` and `questions`. */
export function isPackSpec(value: unknown): value is PackSpec {
	return !!value && typeof value === "object" && "on" in value && "questions" in value;
}

export interface LoadedPacks {
	packs: Pack[];
	errors: string[];
}

function readPackDir(dir: string, origin: Pack["origin"], overrides: Record<string, PackOverride>, out: LoadedPacks): void {
	if (!existsSync(dir)) return;
	for (const file of readdirSync(dir)) {
		if (!file.endsWith(".json")) continue;
		try {
			const spec = JSON.parse(readFileSync(join(dir, file), "utf8")) as PackSpec;
			out.packs.push(normalizePack(spec, origin, overrides[spec.name]));
		} catch (error) {
			out.errors.push(`${join(dir, file)}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

export interface LoadPacksOptions {
	builtins: PackSpec[];
	overrides: Record<string, PackOverride | PackSpec>;
	userDir: string;
	projectDir?: string;
}

/**
 * Built-ins first, then user dir, then project dir, then inline config
 * packs. A later pack with the same name replaces an earlier one, so a
 * project can swap out a built-in wholesale.
 */
export function loadPacks(options: LoadPacksOptions): LoadedPacks {
	const out: LoadedPacks = { packs: [], errors: [] };
	const overrides: Record<string, PackOverride> = {};
	for (const [name, value] of Object.entries(options.overrides)) if (!isPackSpec(value)) overrides[name] = value;

	for (const spec of options.builtins) {
		try {
			out.packs.push(normalizePack(spec, "builtin", overrides[spec.name]));
		} catch (error) {
			out.errors.push(`builtin ${spec.name}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	readPackDir(options.userDir, "user", overrides, out);
	if (options.projectDir) readPackDir(options.projectDir, "project", overrides, out);
	for (const [name, value] of Object.entries(options.overrides)) {
		if (!isPackSpec(value)) continue;
		try {
			out.packs.push(normalizePack({ ...value, name: value.name ?? name }, "config"));
		} catch (error) {
			out.errors.push(`config pack ${name}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	// Last definition of a name wins.
	const byName = new Map<string, Pack>();
	for (const pack of out.packs) byName.set(pack.name, pack);
	out.packs = [...byName.values()];
	return out;
}
