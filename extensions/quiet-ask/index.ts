/**
 * pi-quiet-ask — TypeSafe Jev as pi's quiet decision layer.
 *
 * The main LLM keeps writing code. Jev answers the closed questions the
 * harness has to make dozens of times per session. Most of them are
 * expressed as *packs* (hook + state + questions + rules) run by a small
 * rule engine; two are fixed judges because their actions are specific:
 *
 *   packs     gate (tool_call), output (tool_result), intent (before_agent_start),
 *             honest_finish (agent_end), stuck (turn_end), plus any JSON pack
 *             the user drops in ~/.pi/agent/pi-quiet-ask/packs or .pi/pi-quiet-ask/packs
 *   graph     the task graph: which workflow phase each turn is in, HUD, invariants
 *   triage    should pi-ask's `ask_user` reach the user at all?
 *   jev_ask   a tool so the model can ask the same kind of question itself
 *
 * Everything fails open, everything is recorded, `/quiet` controls it.
 *
 * Config: ~/.pi/agent/pi-quiet-ask.json, then <project>/.pi/pi-quiet-ask.json
 * Key:    TYPESAFE_API_KEY, config `apiKey`, `apiKeyFile`, or <cwd>/.env
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { JevClient } from "./client.ts";
import { CONFIG_FILE, ENV_KEY, historyFilePath, loadConfig, type PackMode, projectPackDir, type QuietAskConfig, resolveApiKey, type TriageMode, userPackDir } from "./config.ts";
import { compactAnswers, Engine } from "./engine/engine.ts";
import { loadPacks, type Pack, type PackOverride, type PackSpec } from "./engine/pack.ts";
import { EvidenceStore } from "./evidence.ts";
import { GraphTracker } from "./graph.ts";
import { formatRecord, HistoryStore, showHistory } from "./history.ts";
import { registerJevAsk } from "./jev-ask.ts";
import { BUILTIN_PACKS } from "./packs/index.ts";
import { createRuntimeSettings, type RuntimeSettings } from "./settings.ts";
import { ASK_USER_TOOL, registerTriage } from "./triage.ts";

interface Runtime {
	client: JevClient;
	config: QuietAskConfig;
	settings: RuntimeSettings;
	history: HistoryStore;
	engine: Engine;
	graph: GraphTracker;
	evidence: EvidenceStore;
	packErrors: string[];
	keySource: string;
}

function statusLine(rt: Runtime): string {
	const { settings, engine } = rt;
	if (!settings.enabled && settings.triageMode === "off") return "quiet off";
	const enforce = engine.packs.filter((p) => p.enabled && p.mode === "enforce").map((p) => p.name);
	const packs = settings.enabled ? `packs:${engine.packs.filter((p) => p.enabled).length}${enforce.length ? ` enforce[${enforce.join(",")}]` : ""}` : "packs:off";
	return `quiet ${packs} triage:${settings.triageMode}${settings.graphEnabled && settings.enabled ? " graph" : ""}`;
}

function formatPackLine(pack: Pack, rt: Runtime): string {
	const s = rt.settings.stats.get(pack.name);
	const counts = s ? `${s.judged} judged, ${s.matched} matched, ${s.intervened} intervened` : "idle";
	const when = pack.when.tool ? ` [${pack.when.tool.join(",")}]` : "";
	return `${pack.enabled ? "on " : "off"} ${pack.name.padEnd(14)} ${pack.on.padEnd(19)}${pack.mode.padEnd(8)} ${pack.origin.padEnd(8)} ${pack.rules.length} rules${when} · ${counts}`;
}

function formatStatus(rt: Runtime, hasAskUser: boolean): string {
	const s = rt.client.stats;
	const c = rt.settings.counters;
	const avg = s.calls - s.errors > 0 ? (s.totalLatencyMs / (s.calls - s.errors)).toFixed(0) : "-";
	const g = rt.settings.stats.get("graph");
	return [
		`pi-quiet-ask · model ${rt.config.model} · key from ${rt.keySource} · judges ${rt.settings.enabled ? "on" : "off"}`,
		...rt.engine.packs.map((pack) => `  ${formatPackLine(pack, rt)}`),
		`  ${rt.settings.graphEnabled ? "on " : "off"} graph          turn_end           ${rt.config.graph.mode.padEnd(8)} builtin  3 invariants · ${g ? `${g.judged} turns, ${g.matched} flagged, ${g.intervened} steered` : "idle"}`,
		`triage: ${rt.settings.triageMode}${hasAskUser ? "" : " (ask_user tool not found — install @eko24ive/pi-ask)"} · auto>=${rt.config.triage.autoAnswer} suggest>=${rt.config.triage.suggest} · ${c.triageJudged} judged, ${c.triageAuto} auto, ${c.triageSuggested} suggested, ${c.triagePassed} passed · jev_ask: ${c.jevAsk}`,
		`jev: ${s.calls} calls, ${s.errors} errors, ${s.cacheHits} cache hits (${rt.client.cacheSize} cached), avg ${avg}ms, ${s.inputTokens}+${s.outputTokens} tokens`,
		...(rt.packErrors.length ? [`pack errors: ${rt.packErrors.join(" | ")}`] : []),
		`packs dir: ${userPackDir()} · history: ${historyFilePath()}`,
		`evidence: ${rt.evidence.filePath() ?? "(disabled)"}`,
		"commands: /quiet on|off · packs · pack <name> on|off|shadow|enforce · mode shadow|enforce · triage off|suggest|auto · graph [on|off|shadow|enforce] · evidence · last [pack] · check <text> · history [kind]",
	].join("\n");
}

const HELP =
	"/quiet — status; /quiet on|off; /quiet packs; /quiet pack <name> on|off|shadow|enforce; /quiet mode shadow|enforce; /quiet triage off|suggest|auto; /quiet graph [on|off|shadow|enforce]; /quiet evidence; /quiet last [pack]; /quiet check <text>; /quiet history [kind]";

export default function quietAskExtension(pi: ExtensionAPI): void {
	let runtime: Runtime | undefined;
	let warnedNoKey = false;

	pi.on("session_start", (_event, ctx) => {
		if (runtime) return;
		const config = loadConfig({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
		const resolved = resolveApiKey(config, ctx.cwd);
		if (!resolved) {
			if (ctx.hasUI && !warnedNoKey) {
				ctx.ui.notify(`pi-quiet-ask: no ${ENV_KEY}; set it in the environment, ${CONFIG_FILE}, or .env. Staying out of the way.`, "warning");
				warnedNoKey = true;
			}
			return;
		}
		const client = new JevClient(resolved.key, config);
		const settings = createRuntimeSettings(config);
		const history = new HistoryStore(pi, config);
		client.onError = (message) => {
			if (ctx.hasUI) ctx.ui.notify(`pi-quiet-ask: Jev unavailable, failing open (${message})`, "warning");
		};

		const loaded = loadPacks({
			builtins: BUILTIN_PACKS,
			overrides: config.packs as Record<string, PackOverride | PackSpec>,
			userDir: userPackDir(),
			projectDir: ctx.isProjectTrusted() ? projectPackDir(ctx.cwd) : undefined,
		});
		const evidence = new EvidenceStore(pi, config, (text) => client.scrub(text));
		const graph = new GraphTracker(pi, client, config, settings, history, evidence);
		const engine = new Engine(
			{ pi, client, config, settings, history, providers: { graph: () => graph.snapshot(), evidence: () => evidence.snapshot() } },
			loaded.packs,
		);
		runtime = { client, config, settings, history, engine, graph, evidence, packErrors: loaded.errors, keySource: resolved.source };

		evidence.register(history, ctx);
		engine.register();
		graph.register();
		if (ctx.hasUI && config.graph.hud) graph.draw(ctx);
		registerTriage(pi, client, config, settings, history);
		registerJevAsk(pi, client, config, settings, history);

		if (loaded.errors.length && ctx.hasUI) ctx.ui.notify(`pi-quiet-ask: ${loaded.errors.length} pack(s) failed to load — /quiet for details`, "warning");
		const hasAskUser = pi.getAllTools().some((tool) => tool.name === ASK_USER_TOOL);
		if (!hasAskUser && settings.triageMode !== "off" && ctx.hasUI) {
			ctx.ui.notify("pi-quiet-ask: ask_user tool not found; triage is idle until @eko24ive/pi-ask is installed.", "info");
		}
		if (ctx.hasUI) ctx.ui.setStatus("quiet", statusLine(runtime));
	});

	pi.registerCommand("quiet", {
		description: "pi-quiet-ask: status, on|off, packs, pack, mode, triage, graph, last, check, history",
		handler: async (args, ctx) => {
			if (!runtime) {
				ctx.ui.notify(`pi-quiet-ask is inactive (no ${ENV_KEY}).`, "warning");
				return;
			}
			const [what, ...rest] = (args ?? "").trim().split(/\s+/).filter(Boolean);
			await handleCommand(pi, runtime, ctx, what, rest);
		},
	});
}

function isMode(value: string | undefined): value is PackMode {
	return value === "shadow" || value === "enforce";
}

async function handleCommand(pi: ExtensionAPI, rt: Runtime, ctx: ExtensionCommandContext, what: string | undefined, rest: string[]): Promise<void> {
	const { settings, engine } = rt;
	const refresh = () => ctx.ui.setStatus("quiet", statusLine(rt));
	const arg = rest[0];

	switch (what) {
		case undefined:
		case "status": {
			const hasAskUser = pi.getAllTools().some((tool) => tool.name === ASK_USER_TOOL);
			ctx.ui.notify(formatStatus(rt, hasAskUser), "info");
			return;
		}
		case "on":
		case "off":
			settings.enabled = what === "on";
			refresh();
			ctx.ui.notify(`pi-quiet-ask packs + graph ${what} (triage stays ${settings.triageMode}; use /quiet triage …)`, "info");
			return;
		case "packs":
			ctx.ui.notify(engine.packs.map((pack) => formatPackLine(pack, rt)).join("\n") || "no packs loaded", "info");
			return;
		case "pack": {
			const pack = arg ? engine.find(arg) : undefined;
			const verb = rest[1];
			if (!pack) return void ctx.ui.notify(`usage: /quiet pack <${engine.packs.map((p) => p.name).join("|")}> on|off|shadow|enforce`, "warning");
			if (verb === "on" || verb === "off") pack.enabled = verb === "on";
			else if (isMode(verb)) pack.mode = verb;
			else {
				const lines = [formatPackLine(pack, rt), pack.description, `state: ${pack.state.join(", ")}`, `vars: ${JSON.stringify(pack.vars)}`, "rules:", ...pack.rules.map((r) => `  ${r.name}: if ${r.source} → ${r.actions.map((a) => a.do).join(", ")}`)];
				return void ctx.ui.notify(lines.join("\n"), "info");
			}
			refresh();
			ctx.ui.notify(`pack ${pack.name}: ${pack.enabled ? pack.mode : "off"}`, "info");
			return;
		}
		case "mode": {
			if (!isMode(arg)) return void ctx.ui.notify("usage: /quiet mode shadow|enforce   (all packs + graph; use /quiet pack <name> … for one)", "warning");
			for (const pack of engine.packs) pack.mode = arg;
			rt.config.graph.mode = arg;
			refresh();
			ctx.ui.notify(`all packs + graph: ${arg}`, "info");
			return;
		}
		case "triage": {
			const mode = (arg === "on" ? "auto" : arg) as TriageMode;
			if (mode !== "off" && mode !== "suggest" && mode !== "auto") return void ctx.ui.notify("usage: /quiet triage off|suggest|auto", "warning");
			settings.triageMode = mode;
			refresh();
			ctx.ui.notify(`triage: ${mode}`, "info");
			return;
		}
		case "graph": {
			if (arg === "on" || arg === "off") settings.graphEnabled = arg === "on";
			else if (isMode(arg)) rt.config.graph.mode = arg;
			else if (arg === undefined) return void rt.graph.show(ctx);
			else return void ctx.ui.notify("usage: /quiet graph [on|off|shadow|enforce]", "warning");
			refresh();
			ctx.ui.notify(`graph: ${settings.graphEnabled ? rt.config.graph.mode : "off"}`, "info");
			return;
		}
		case "evidence":
			rt.evidence.show(ctx);
			return;
		case "last": {
			const name = arg ?? "gate";
			const verdict = settings.lastByPack.get(name);
			if (!verdict) return void ctx.ui.notify(`no ${name} verdict yet`, "info");
			ctx.ui.notify(`${name} · ${verdict.tool ?? verdict.hook} · ${compactAnswers(verdict.answers)} → ${verdict.matched.join(", ") || "clear"}${verdict.cached ? " (cached)" : ` (${verdict.latencyMs.toFixed(0)}ms)`}`, "info");
			return;
		}
		case "check": {
			const text = rest.join(" ");
			const gate = engine.find("gate");
			if (!text || !gate) return void ctx.ui.notify("usage: /quiet check <command or text>  (needs the gate pack)", "warning");
			const verdict = await engine.judge(gate, { hook: "tool_call", tool: "bash", arguments: { command: text } }, ctx, text);
			if (!verdict) return void ctx.ui.notify("Jev did not answer", "warning");
			ctx.ui.notify(
				formatRecord({
					at: new Date().toISOString(),
					kind: "gate",
					sessionId: "",
					tool: "bash",
					action: verdict.matched.length ? `flag(${verdict.matched.join(",")})` : "allow",
					summary: text,
					answers: verdict.answers,
					latencyMs: verdict.latencyMs,
					cached: verdict.cached,
					mode: "check",
				}),
				"info",
			);
			return;
		}
		case "history":
			await showHistory(ctx, arg || undefined);
			return;
		default:
			ctx.ui.notify(HELP, "info");
	}
}
