/**
 * Observed closed action spaces — the coding-agent analogue of
 * jev-ultrafast's element table.
 *
 * Jev cannot invent members. Code reads the evidence ledger (and, for
 * gate, the tool arguments), numbers the items, and only those ids are
 * valid Choice criteria. `none` is always offered so the model can refuse.
 */

export const SPACE_NAMES = ["unverified_files", "recent_failures", "commands", "verify_targets", "argument_paths"] as const;
export type SpaceName = (typeof SPACE_NAMES)[number];

export const NONE = "none";
const MAX_OPTIONS = 16;
const VERIFYING = new Set(["test", "typecheck", "lint", "build", "run"]);

export interface SpaceFacts {
	files_changed?: Array<string | { path: string }>;
	commands?: Array<{ command: string; kind?: string; is_error?: boolean }>;
	verifications?: Array<{ command: string; kind?: string; passed?: boolean; after_last_change?: boolean }>;
	arguments?: unknown;
}

export interface ObservedOption {
	id: string;
	kind: "file" | "command" | "failure" | "path";
	label: string;
	/** The thing the agent can actually run or open. */
	value: string;
	description: string;
}

export interface ObservedSpace {
	name: SpaceName;
	options: ObservedOption[];
	criteria: Record<string, string>;
	byId: Map<string, ObservedOption>;
}

export function isSpaceName(value: string): value is SpaceName {
	return (SPACE_NAMES as readonly string[]).includes(value);
}

export function spaceFallback(name: SpaceName): string {
	switch (name) {
		case "unverified_files":
		case "verify_targets":
			return "the relevant test, build, type check, or execution";
		case "recent_failures":
			return "the same action";
		case "commands":
			return "that command";
		case "argument_paths":
			return "this path";
	}
}

function unique(items: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of items) {
		const item = raw.trim();
		if (!item || seen.has(item)) continue;
		seen.add(item);
		out.push(item);
	}
	return out;
}

function fileName(path: string): string {
	return path.split(/[\\/]/).at(-1) ?? path;
}

function clip(text: string, n = 72): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

function pathsOf(facts: SpaceFacts): string[] {
	return unique((facts.files_changed ?? []).map((f) => (typeof f === "string" ? f : f.path)).filter(Boolean));
}

/** Files still needing a check: empty when a verification passed after the last edit. */
export function unverifiedFiles(facts: SpaceFacts): string[] {
	const verifiedNow = (facts.verifications ?? []).some((v) => v.after_last_change && v.passed);
	if (verifiedNow) return [];
	return pathsOf(facts);
}

function failedCommands(facts: SpaceFacts): string[] {
	return unique((facts.commands ?? []).filter((c) => c.is_error).map((c) => c.command));
}

function allCommands(facts: SpaceFacts): string[] {
	return unique((facts.commands ?? []).map((c) => c.command));
}

/** Stale or failed checks, plus any verifying command the run already tried. */
export function suggestedChecks(facts: SpaceFacts): string[] {
	const stale = (facts.verifications ?? []).filter((v) => !v.after_last_change || !v.passed).map((v) => v.command);
	const verifying = (facts.commands ?? []).filter((c) => VERIFYING.has(c.kind ?? "")).map((c) => c.command);
	return unique([...stale, ...verifying]);
}

const PATH_TOKEN = /^(?:[~.]{0,2}\/)?[\w.@+-]+(?:\/[\w.@+-]+)+\.\w{1,8}$|^(?:[~.]{0,2}\/)?[\w.@+-]+\/[\w./@+-]+$|\.\w{1,8}$/;

/** Paths the tool call already named. Never invented. */
export function pathsFromArguments(args: unknown): string[] {
	if (!args || typeof args !== "object") return [];
	const record = args as Record<string, unknown>;
	const found: string[] = [];
	for (const key of ["path", "file", "filename", "target"]) {
		if (typeof record[key] === "string") found.push(record[key]);
	}
	if (typeof record.command === "string") {
		for (const token of record.command.split(/\s+/)) {
			if (token.startsWith("-")) continue;
			const cleaned = token.replace(/^[`'"]|[`'"]$/g, "");
			if (PATH_TOKEN.test(cleaned) || /[\\/]/.test(cleaned)) found.push(cleaned);
		}
	}
	return unique(found);
}

function pushFile(options: ObservedOption[], path: string): void {
	const n = options.filter((o) => o.kind === "file").length + 1;
	options.push({
		id: `f${n}`,
		kind: "file",
		label: fileName(path),
		value: path,
		description: `changed file ${path}; no passing check after the last edit`,
	});
}

function pushCommand(options: ObservedOption[], command: string, kind: ObservedOption["kind"]): void {
	const prefix = kind === "failure" ? "c" : "c";
	const n = options.filter((o) => o.kind === "command" || o.kind === "failure").length + 1;
	options.push({
		id: `${prefix}${n}`,
		kind,
		label: clip(command, 48),
		value: command,
		description: kind === "failure" ? `failed command: ${clip(command)}` : `observed check: ${clip(command)}`,
	});
}

export function buildSpace(name: SpaceName, facts: SpaceFacts): ObservedSpace {
	const options: ObservedOption[] = [];
	switch (name) {
		case "unverified_files":
			for (const path of unverifiedFiles(facts).slice(-MAX_OPTIONS)) pushFile(options, path);
			break;
		case "recent_failures":
			for (const command of failedCommands(facts).slice(-MAX_OPTIONS)) pushCommand(options, command, "failure");
			break;
		case "commands":
			for (const command of allCommands(facts).slice(-MAX_OPTIONS)) pushCommand(options, command, "command");
			break;
		case "verify_targets": {
			const files = unverifiedFiles(facts).slice(-12);
			const checks = suggestedChecks(facts).slice(-8);
			for (const path of files) pushFile(options, path);
			for (const command of checks) {
				if (options.length >= MAX_OPTIONS) break;
				pushCommand(options, command, "command");
			}
			break;
		}
		case "argument_paths":
			for (const path of pathsFromArguments(facts.arguments).slice(0, MAX_OPTIONS)) {
				const n = options.length + 1;
				options.push({
					id: `p${n}`,
					kind: "path",
					label: fileName(path),
					value: path,
					description: `path named in the tool arguments: ${path}`,
				});
			}
			break;
	}

	const criteria: Record<string, string> = {
		[NONE]: "none of the listed items is the right target; no observed member fits",
	};
	for (const option of options) criteria[option.id] = option.description;
	return { name, options, criteria, byId: new Map(options.map((o) => [o.id, o])) };
}

export function spaceFactsFromPrompt(prompt: {
	files_changed: Array<{ path: string }>;
	commands: Array<{ command: string; kind?: string; is_error?: boolean }>;
	verifications: Array<{ command: string; kind?: string; passed?: boolean; after_last_change?: boolean }>;
}): SpaceFacts {
	return { files_changed: prompt.files_changed, commands: prompt.commands, verifications: prompt.verifications };
}
