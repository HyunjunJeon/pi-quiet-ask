/**
 * What leaves the machine, and in what shape.
 *
 * Every state object sent to TypeSafe passes through `prepareState`:
 *
 *   1. long strings are cut to `argumentChars` with an explicit marker, so a
 *      5 KB file body leaves as its first 400 characters;
 *   2. secrets are replaced with `<REDACTED:kind>` before the cut so the
 *      marker never hides half a token;
 *   3. the whole JSON is capped at `maxStateChars`.
 *
 * The same `redactSecrets` is applied to notification text so a registered
 * API key can never reach the session transcript.
 */

interface SecretPattern {
	kind: string;
	pattern: RegExp;
}

/**
 * Ordered patterns; the first match wins per span. Kept deliberately
 * conservative: a false positive only costs Jev some context, a false
 * negative ships a credential.
 */
const SECRET_PATTERNS: SecretPattern[] = [
	{ kind: "pem", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
	{ kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
	{ kind: "aws", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
	{ kind: "github", pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
	{ kind: "openai", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
	{ kind: "slack", pattern: /\bxox[abpors]-[A-Za-z0-9-]{10,}\b/g },
	{ kind: "bearer", pattern: /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{16,}/g },
	{
		// KEY=..., "token": "...", password: ... with a long high-entropy value.
		kind: "assignment",
		pattern:
			/\b([A-Za-z0-9_]*(?:key|token|secret|password|passwd|credential)[A-Za-z0-9_]*)(["']?\s*[:=]\s*["']?)([A-Za-z0-9+/_.~-]{16,})/gi,
	},
];

const ASSIGNMENT_KIND = "assignment";

/** Replace recognised credentials with `<REDACTED:kind>`. */
export function redactSecrets(text: string, extraLiterals: readonly string[] = []): string {
	let out = text;
	for (const literal of extraLiterals) {
		if (literal.length >= 8) out = out.split(literal).join("<REDACTED:key>");
	}
	for (const { kind, pattern } of SECRET_PATTERNS) {
		out = out.replace(pattern, (match: string, ...groups: unknown[]) =>
			kind === ASSIGNMENT_KIND ? `${String(groups[0])}${String(groups[1])}<REDACTED:${kind}>` : `<REDACTED:${kind}>`,
		);
	}
	return out;
}

/** Cut a string and say how much was dropped, so Jev knows the input is partial. */
export function truncate(text: string, limit: number): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}…[${text.length - limit} chars elided]`;
}

export interface PrepareOptions {
	/** Per-string limit. */
	stringChars: number;
	/** Whole-payload limit after serialisation. */
	maxChars: number;
	/** Literal values (the API key) that must never appear. */
	secrets?: readonly string[];
}

function walk(value: unknown, options: PrepareOptions): unknown {
	if (typeof value === "string") return truncate(redactSecrets(value, options.secrets), options.stringChars);
	if (Array.isArray(value)) return value.map((item) => walk(item, options));
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = walk(item, options);
		return out;
	}
	return value;
}

const MARKER = /<REDACTED:[a-z]+>/g;

/** How many `<REDACTED:kind>` markers a prepared payload contains. */
export function countRedactions(json: string): number {
	return json.match(MARKER)?.length ?? 0;
}

export interface PreparedState {
	state: unknown;
	/** Serialised size of what leaves the machine. */
	chars: number;
	/**
	 * Number of credentials the local patterns removed. A non-zero count is
	 * hard evidence that the original text contained a secret, independent
	 * of anything Jev says about the redacted remainder.
	 */
	redactions: number;
}

/**
 * Redact, truncate, and cap a state object. Returns the prepared object,
 * its serialised size, and how many secrets were removed on the way.
 */
export function prepareState(state: unknown, options: PrepareOptions): PreparedState {
	const prepared = walk(state, options);
	const json = JSON.stringify(prepared);
	const redactions = countRedactions(json);
	if (json.length <= options.maxChars) return { state: prepared, chars: json.length, redactions };
	// Over budget even after per-string cuts: ship a single truncated string.
	const clipped = truncate(json, options.maxChars);
	return { state: { truncated_json: clipped }, chars: clipped.length, redactions };
}
