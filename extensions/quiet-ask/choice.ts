/**
 * Closed-set Choice answers. An invented id never becomes an action.
 *
 * Fail-open for the sidecar: a malformed answer is `undefined` and the
 * caller keeps the generic wording. Only a choice that is in the
 * observed id set, and is the max of its distribution, is consumed.
 */

import { NONE, type ObservedOption, type ObservedSpace } from "./space.ts";

export interface ValidatedChoice {
	choice: string;
	confidence: number;
	probabilities: Record<string, number>;
}

function asProbabilities(value: unknown): Record<string, number> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const out: Record<string, number> = {};
	for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
		const n = typeof raw === "number" ? raw : Number(raw);
		if (!Number.isFinite(n) || n < 0 || n > 1) return undefined;
		out[key] = n;
	}
	return out;
}

export function validateChoice(answer: unknown, ids: Iterable<string>): ValidatedChoice | undefined {
	const allowed = new Set(ids);
	if (!answer || typeof answer !== "object" || allowed.size === 0) return undefined;
	const raw = answer as Record<string, unknown>;
	if (typeof raw.choice !== "string" || !allowed.has(raw.choice)) return undefined;
	const confidence = typeof raw.confidence === "number" && Number.isFinite(raw.confidence) && raw.confidence >= 0 && raw.confidence <= 1 ? raw.confidence : 0;
	if (raw.probabilities !== undefined) {
		const probabilities = asProbabilities(raw.probabilities);
		if (!probabilities) return undefined;
		const peak = probabilities[raw.choice];
		if (peak === undefined) return undefined;
		const max = Math.max(...Object.values(probabilities));
		if (peak < max - 1e-6) return undefined;
		return { choice: raw.choice, confidence, probabilities };
	}
	return { choice: raw.choice, confidence, probabilities: { [raw.choice]: 1 } };
}

/** Only an observed member (never `none`, never an invented key). */
export function consumeTarget(answer: unknown, space: ObservedSpace): ObservedOption | undefined {
	const validated = validateChoice(answer, Object.keys(space.criteria));
	if (!validated || validated.choice === NONE) return undefined;
	return space.byId.get(validated.choice);
}
