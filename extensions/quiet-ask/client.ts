/**
 * The Jev client used by every judge in this package.
 *
 * Guarantees the rest of the code relies on:
 *
 *   - fail-open: a missing key, timeout, 429, or malformed answer yields
 *     `result === undefined`; callers then do what pi would do anyway;
 *   - one report per minute at most, so a dead endpoint cannot flood
 *     the transcript;
 *   - identical `{questions, state}` is judged once per `cacheSeconds`, and
 *     concurrent identical calls share one in-flight request (sibling tool
 *     calls from the same assistant message hit this constantly);
 *   - the state has already been redacted and truncated by the caller via
 *     `prepareState`; this module never sees raw arguments.
 */

import { createHash } from "node:crypto";
import { type Questions, type SystemOneResult, TypeSafeClient, TypeSafeError } from "@typesafe-ai/sdk";
import type { QuietAskConfig } from "./config.ts";
import { redactSecrets } from "./redact.ts";

export interface JevCall<Q extends Questions> {
	result?: SystemOneResult<Q>;
	latencyMs: number;
	error?: string;
	cached: boolean;
}

export interface JevStats {
	calls: number;
	cacheHits: number;
	errors: number;
	totalLatencyMs: number;
	inputTokens: number;
	outputTokens: number;
}

interface CacheEntry {
	result: SystemOneResult<Questions>;
	expiresAt: number;
}

const ERROR_REPORT_INTERVAL_MS = 60_000;

export class JevClient {
	readonly stats: JevStats = { calls: 0, cacheHits: 0, errors: 0, totalLatencyMs: 0, inputTokens: 0, outputTokens: 0 };
	private readonly sdk: TypeSafeClient;
	private readonly cache = new Map<string, CacheEntry>();
	private readonly inFlight = new Map<string, Promise<SystemOneResult<Questions>>>();
	private lastErrorReportAt = 0;
	/** Set by the extension to surface errors to the user; rate limited here. */
	onError?: (message: string) => void;

	private readonly apiKey: string;

	constructor(apiKey: string, config: QuietAskConfig) {
		this.apiKey = apiKey;
		this.sdk = new TypeSafeClient({
			apiKey,
			defaultModel: config.model,
			timeout: config.timeoutMs,
			// A late answer is worse than none on the tool-call hot path.
			retry: { maxRetries: 0 },
			logLevel: "off",
		});
	}

	/** Strip the API key (and anything that looks like one) from user-facing text. */
	scrub(text: string): string {
		return redactSecrets(text, [this.apiKey]);
	}

	/** Ask Jev; `cacheSeconds` 0 disables the cache for this call. */
	async ask<const Q extends Questions>(
		state: unknown,
		questions: Q,
		options: { signal?: AbortSignal; cacheSeconds?: number } = {},
	): Promise<JevCall<Q>> {
		const key = cacheKey(state, questions);
		const cacheSeconds = options.cacheSeconds ?? 0;
		const started = performance.now();

		if (cacheSeconds > 0) {
			const hit = this.cache.get(key);
			if (hit && hit.expiresAt > Date.now()) {
				this.stats.cacheHits += 1;
				return { result: hit.result as SystemOneResult<Q>, latencyMs: 0, cached: true };
			}
		}

		try {
			let pending = this.inFlight.get(key);
			if (!pending) {
				pending = this.sdk.systemOne(
					{ state: state as Parameters<TypeSafeClient["systemOne"]>[0]["state"], questions },
					{ signal: options.signal },
				) as Promise<SystemOneResult<Questions>>;
				this.inFlight.set(key, pending);
				pending.finally(() => this.inFlight.delete(key)).catch(() => {});
			}
			const result = (await pending) as SystemOneResult<Q>;
			const latencyMs = performance.now() - started;
			this.stats.calls += 1;
			this.stats.totalLatencyMs += latencyMs;
			this.stats.inputTokens += result.usage?.input_tokens ?? 0;
			this.stats.outputTokens += result.usage?.output_tokens ?? 0;
			if (cacheSeconds > 0) {
				this.cache.set(key, { result, expiresAt: Date.now() + cacheSeconds * 1000 });
				this.evict();
			}
			return { result, latencyMs, cached: false };
		} catch (error) {
			const latencyMs = performance.now() - started;
			this.stats.calls += 1;
			this.stats.errors += 1;
			this.stats.totalLatencyMs += latencyMs;
			const message = error instanceof TypeSafeError ? `${error.name}: ${error.message}` : String(error);
			this.report(message);
			return { latencyMs, error: this.scrub(message), cached: false };
		}
	}

	get cacheSize(): number {
		return this.cache.size;
	}

	private report(message: string): void {
		const now = Date.now();
		if (now - this.lastErrorReportAt < ERROR_REPORT_INTERVAL_MS) return;
		this.lastErrorReportAt = now;
		this.onError?.(this.scrub(message));
	}

	private evict(): void {
		if (this.cache.size < 256) return;
		const now = Date.now();
		for (const [key, entry] of this.cache) if (entry.expiresAt <= now) this.cache.delete(key);
	}
}

function cacheKey(state: unknown, questions: Questions): string {
	return createHash("sha256").update(JSON.stringify({ state, questions })).digest("hex");
}
