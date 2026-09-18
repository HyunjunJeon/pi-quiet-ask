/**
 * Per-session runtime state. Config files give the defaults; `/quiet`
 * commands change these for the running session without a reload.
 */

import type { QuietAskConfig, TriageMode } from "./config.ts";
import type { PackVerdict } from "./engine/engine.ts";

export interface Counters {
	triageJudged: number;
	triageAuto: number;
	triageSuggested: number;
	triagePassed: number;
	jevAsk: number;
	jevChoose: number;
}

export interface PackStats {
	judged: number;
	/** Judgements where at least one rule held. */
	matched: number;
	/** Judgements where an intervening action actually ran (enforce only). */
	intervened: number;
}

export interface RuntimeSettings {
	/** Master switch for every pack and the graph. Triage has its own mode. */
	enabled: boolean;
	triageMode: TriageMode;
	graphEnabled: boolean;
	counters: Counters;
	stats: Map<string, PackStats>;
	lastByPack: Map<string, PackVerdict>;
	packStats(name: string): PackStats;
}

export function createRuntimeSettings(config: QuietAskConfig): RuntimeSettings {
	const stats = new Map<string, PackStats>();
	return {
		enabled: true,
		triageMode: config.triage.mode,
		graphEnabled: config.graph.enabled,
		counters: { triageJudged: 0, triageAuto: 0, triageSuggested: 0, triagePassed: 0, jevAsk: 0, jevChoose: 0 },
		stats,
		lastByPack: new Map(),
		packStats(name: string): PackStats {
			let entry = stats.get(name);
			if (!entry) {
				entry = { judged: 0, matched: 0, intervened: 0 };
				stats.set(name, entry);
			}
			return entry;
		},
	};
}
