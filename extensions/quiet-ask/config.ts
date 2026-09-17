/**
 * Configuration: defaults, layered JSON files, and API key resolution.
 *
 * Layering (later wins, and a file only overrides the keys it sets):
 *
 *   built-in defaults
 *   ~/.pi/agent/pi-quiet-ask.json      (user)
 *   <project>/.pi/pi-quiet-ask.json    (project, only when trusted)
 *
 * The API key resolves in this order: `TYPESAFE_API_KEY` env var, `apiKey`
 * in the config, `apiKeyFile` (a path, `~/` expanded), then `<cwd>/.env`.
 * The key itself is never written back into any config or history file.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const ENV_KEY = "TYPESAFE_API_KEY";
export const CONFIG_FILE = "pi-quiet-ask.json";
/** Directory under the agent dir for history and other state files. */
export const STATE_DIR = "pi-quiet-ask";

export type PackMode = "shadow" | "enforce";
export type TriageMode = "off" | "suggest" | "auto";

export interface TriageConfig {
	/** off: never touch ask_user. suggest: mark Jev's pick. auto: also submit it. */
	mode: TriageMode;
	/** P(option) and P(determined) both at or above this -> auto-answer. */
	autoAnswer: number;
	/** P(option) at or above this -> mark the option as recommended. */
	suggest: number;
	/** Add a note to auto-answers so the model knows the user was not asked. */
	note: boolean;
}

export interface HistoryConfig {
	/** Also append every decision to <agentDir>/pi-quiet-ask/history.jsonl. */
	file: boolean;
	/** Keep the redacted state that was sent to Jev in each record. */
	keepState: boolean;
}

export interface GraphConfig {
	enabled: boolean;
	/** shadow: HUD + history only. enforce: steer once per invariant per prompt. */
	mode: PackMode;
	hud: boolean;
	/** Consecutive stalled explore turns before `explore_loop` fires. */
	exploreLoop: number;
	/** Drift probability that counts as drifting (two turns in a row fire). */
	drift: number;
	/** Progress probability below which an explore turn counts as stalled. */
	stalled: number;
}

export interface EvidenceConfig {
	/** Write <dir>/<sessionId>.json after every change. */
	file: boolean;
	/** Directory for ledgers; default <agentDir>/pi-quiet-ask/evidence. `~/` is expanded. */
	dir?: string;
}

export interface QuietAskConfig {
	apiKey?: string;
	apiKeyFile?: string;
	model: string;
	timeoutMs: number;
	/** Hard cap on the serialised state sent to Jev. */
	maxStateChars: number;
	/** Any string in a state longer than this is cut before leaving the machine. */
	argumentChars: number;
	/** Only the first N characters of a tool result are judged. */
	outputChars: number;
	/** In headless runs a `confirm` action cannot ask; warn (let it run) or block. */
	headlessConfirm: "warn" | "block";
	/**
	 * Per-pack overrides keyed by pack name (`enabled`, `mode`, `cacheSeconds`,
	 * `vars`, `when`), or a complete pack definition (has `on` + `questions`).
	 * Typed loosely here; `engine/pack.ts` validates.
	 */
	packs: Record<string, Record<string, unknown>>;
	triage: TriageConfig;
	graph: GraphConfig;
	history: HistoryConfig;
	evidence: EvidenceConfig;
}

export const DEFAULT_CONFIG: QuietAskConfig = {
	model: "jev-latest",
	timeoutMs: 4000,
	maxStateChars: 8000,
	argumentChars: 400,
	outputChars: 2000,
	headlessConfirm: "warn",
	packs: {},
	triage: {
		mode: "auto",
		autoAnswer: 0.9,
		suggest: 0.5,
		note: true,
	},
	graph: {
		enabled: true,
		mode: "shadow",
		hud: true,
		exploreLoop: 4,
		drift: 0.8,
		stalled: 0.4,
	},
	history: {
		file: true,
		keepState: true,
	},
	evidence: {
		file: true,
	},
};

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Recursive merge where `overlay` only replaces the keys it defines. */
function deepMerge<T>(base: T, overlay: unknown): T {
	if (!isPlainObject(base) || !isPlainObject(overlay)) return base;
	const out: PlainObject = { ...base };
	for (const [key, value] of Object.entries(overlay)) {
		const current = out[key];
		out[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
	}
	return out as T;
}

function readJson(path: string): unknown {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		// An unparsable file is ignored; the previous layer stays in effect.
		return undefined;
	}
}

export function expandTilde(path: string): string {
	return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

export interface LoadConfigOptions {
	cwd: string;
	projectTrusted: boolean;
}

/** Load defaults + user file + (trusted) project file. */
export function loadConfig(options: LoadConfigOptions): QuietAskConfig {
	let config = DEFAULT_CONFIG;
	config = deepMerge(config, readJson(join(getAgentDir(), CONFIG_FILE)));
	if (options.projectTrusted) {
		config = deepMerge(config, readJson(join(options.cwd, ".pi", CONFIG_FILE)));
	}
	return config;
}

export type KeySource = "env" | "config" | "file" | "dotenv";

export interface ResolvedKey {
	key: string;
	source: KeySource;
}

/** Minimal `.env` reader for `KEY=value` lines; quotes are stripped. */
function readDotEnv(cwd: string, name: string): string | undefined {
	const path = join(cwd, ".env");
	if (!existsSync(path)) return undefined;
	for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
		const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
		if (match && match[1] === name) return match[2].replace(/^["']|["']$/g, "");
	}
	return undefined;
}

export function resolveApiKey(config: QuietAskConfig, cwd: string): ResolvedKey | undefined {
	const fromEnv = process.env[ENV_KEY]?.trim();
	if (fromEnv) return { key: fromEnv, source: "env" };
	if (config.apiKey?.trim()) return { key: config.apiKey.trim(), source: "config" };
	if (config.apiKeyFile) {
		const path = expandTilde(config.apiKeyFile);
		if (existsSync(path)) {
			const key = readFileSync(path, "utf8").trim();
			if (key) return { key, source: "file" };
		}
	}
	const fromDotEnv = readDotEnv(cwd, ENV_KEY)?.trim();
	if (fromDotEnv) return { key: fromDotEnv, source: "dotenv" };
	return undefined;
}

/** Path of the cross-session history file. */
export function historyFilePath(): string {
	return join(getAgentDir(), STATE_DIR, "history.jsonl");
}

/** User-level pack directory: `~/.pi/agent/pi-quiet-ask/packs/`. */
export function userPackDir(): string {
	return join(getAgentDir(), STATE_DIR, "packs");
}

/** Project-level pack directory: `<project>/.pi/pi-quiet-ask/packs/`. */
export function projectPackDir(cwd: string): string {
	return join(cwd, ".pi", STATE_DIR, "packs");
}

/** Where evidence ledgers go: `evidence.dir` or `<agentDir>/pi-quiet-ask/evidence/`. */
export function evidenceDir(config: QuietAskConfig): string {
	return config.evidence.dir ? expandTilde(config.evidence.dir) : join(getAgentDir(), STATE_DIR, "evidence");
}
