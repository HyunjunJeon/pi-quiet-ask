/**
 * Triage: keep pi-ask's `ask_user` from reaching the user when the
 * conversation already answers the question.
 *
 * pi-ask (https://github.com/eko24ive/pi-ask) is the de-facto clarification
 * tool for pi. Instead of shipping a competing `question` tool, this module
 * plugs into two seams pi exposes for exactly this purpose:
 *
 *   1. `tool_call` for `ask_user` fires before the form opens. We judge every
 *      question with Jev in one request, and (in `suggest`/`auto` mode) mark
 *      Jev's pick as `recommended` by mutating `event.input` in place, which
 *      pi documents as the supported way to modify arguments. The form still
 *      opens with the pick highlighted but not preselected.
 *
 *   2. pi-ask's remote contract: `@eko24ive/pi-ask:started` is emitted once
 *      the form is open, with `flowId = tool:<toolCallId>`. In `auto` mode,
 *      when every question was determined above threshold, we emit
 *      `@eko24ive/pi-ask:submit` with the picks, and pi-ask closes the form
 *      and returns a normal result to the model. The user sees the form for
 *      a moment and a notification saying what was answered.
 *
 * Blocking the tool call would have handed the model an *error*, so the
 * event contract is the only route that yields a real answer.
 *
 *   `off`      never touch ask_user
 *   `suggest`  mark Jev's pick, always ask
 *   `auto`     suggest + submit when P(pick) and P(determined) both clear
 *              `triage.autoAnswer` for every question in the call
 *
 * Multi-select questions are never auto-answered. Every decision is written
 * to history and updated with the final answers when the flow completes, so
 * `/quiet history triage` shows Jev's pick next to what actually happened.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type ChoiceCriteria, choice } from "@typesafe-ai/sdk";
import type { JevClient } from "./client.ts";
import type { QuietAskConfig } from "./config.ts";
import { buildConversationState } from "./context.ts";
import type { HistoryStore } from "./history.ts";
import { ASK_USER, TRIAGE_CHOICE_INSTRUCTIONS, TRIAGE_DETERMINED } from "./questions.ts";
import { prepareState } from "./redact.ts";
import type { RuntimeSettings } from "./settings.ts";

export const ASK_USER_TOOL = "ask_user";
const PI_ASK_STARTED = "@eko24ive/pi-ask:started";
const PI_ASK_COMPLETED = "@eko24ive/pi-ask:completed";
const PI_ASK_SUBMIT = "@eko24ive/pi-ask:submit";
const PI_ASK_SUBMIT_RESULT = "@eko24ive/pi-ask:submit-result";

/** Sentinel used when an option is literally called `ask_user`. */
const SENTINEL = `__${ASK_USER}__`;
const MAX_QUESTIONS = 8;

// --- pi-ask input shape (docs/contract.md) ---------------------------------

interface AskOption {
	value: string;
	label?: string;
	description?: string;
	recommended?: boolean;
}

interface AskQuestion {
	id: string;
	label?: string;
	prompt: string;
	type?: "single" | "multi" | "preview";
	options: AskOption[];
}

interface AskInput {
	title?: string;
	questions: AskQuestion[];
}

function isAskInput(value: unknown): value is AskInput {
	if (!value || typeof value !== "object") return false;
	const questions = (value as { questions?: unknown }).questions;
	return (
		Array.isArray(questions) &&
		questions.length > 0 &&
		questions.every(
			(q) =>
				q &&
				typeof q === "object" &&
				typeof (q as AskQuestion).id === "string" &&
				typeof (q as AskQuestion).prompt === "string" &&
				Array.isArray((q as AskQuestion).options) &&
				(q as AskQuestion).options.every((o) => o && typeof o === "object" && typeof (o as AskOption).value === "string"),
		)
	);
}

// --- verdicts ---------------------------------------------------------------

export type TriageAction = "auto" | "suggest" | "pass";

export interface TriageQuestionVerdict {
	id: string;
	prompt: string;
	type: "single" | "multi" | "preview";
	/** Option value Jev picked, or null for ask_user. */
	pick: string | null;
	pickLabel: string | null;
	probability: number;
	determined: number;
	action: TriageAction;
}

export interface TriageVerdict {
	toolCallId: string;
	questions: TriageQuestionVerdict[];
	/** True when every question may be submitted without the user. */
	auto: boolean;
	latencyMs: number;
	cached: boolean;
	answers: Record<string, unknown>;
	state: unknown;
}

function criteriaFor(question: AskQuestion): ChoiceCriteria {
	const criteria: Record<string, string | null> = {};
	for (const option of question.options) {
		const label = option.label && option.label !== option.value ? option.label : "";
		const parts = [label, option.description].filter((p): p is string => !!p && p.trim().length > 0);
		criteria[option.value] = parts.length > 0 ? parts.join(": ") : null;
	}
	const sentinel = ASK_USER in criteria ? SENTINEL : ASK_USER;
	criteria[sentinel] =
		"the answer is not already in `user_request`, `last_user_message`, or `recent`; the user must be asked";
	return criteria;
}

function pickKey(id: string): string {
	return `${id}__pick`;
}

function determinedKey(id: string): string {
	return `${id}__determined`;
}

export async function judgeAsk(
	client: JevClient,
	config: QuietAskConfig,
	settings: RuntimeSettings,
	toolCallId: string,
	input: AskInput,
	ctx: ExtensionContext,
): Promise<TriageVerdict | undefined> {
	const questions = input.questions.slice(0, MAX_QUESTIONS);
	const jevQuestions: Record<string, ReturnType<typeof choice> | typeof TRIAGE_DETERMINED> = {};
	for (const q of questions) {
		jevQuestions[pickKey(q.id)] = choice(`${TRIAGE_CHOICE_INSTRUCTIONS} Answer for questions["${q.id}"].`, criteriaFor(q));
		jevQuestions[determinedKey(q.id)] = {
			...TRIAGE_DETERMINED,
			instructions: `${String(TRIAGE_DETERMINED.instructions)} Answer for questions["${q.id}"].`,
		};
	}

	const conversation = buildConversationState(ctx);
	const { state } = prepareState(
		{
			user_request: conversation.user_request,
			last_user_message: conversation.last_user_message,
			recent: conversation.recent,
			cwd: ctx.cwd,
			title: input.title,
			questions: Object.fromEntries(
				questions.map((q) => [
					q.id,
					{
						prompt: q.prompt,
						type: q.type ?? "single",
						options: q.options.map((o) => ({
							value: o.value,
							label: o.label,
							description: o.description,
						})),
					},
				]),
			),
		},
		{ stringChars: 600, maxChars: config.maxStateChars },
	);

	const call = await client.ask(state, jevQuestions, { signal: ctx.signal });
	if (!call.result) return undefined;

	const answers = call.result.answers as Record<string, { choice?: string; probabilities?: Record<string, number>; noul?: number }>;
	const verdicts: TriageQuestionVerdict[] = questions.map((q) => {
		const pickAnswer = answers[pickKey(q.id)];
		const determined = answers[determinedKey(q.id)]?.noul ?? 0;
		const chosen = pickAnswer?.choice ?? ASK_USER;
		const isSentinel = chosen === ASK_USER || chosen === SENTINEL || !q.options.some((o) => o.value === chosen);
		const probability = isSentinel ? 0 : (pickAnswer?.probabilities?.[chosen] ?? 0);
		const type = q.type ?? "single";
		let action: TriageAction = "pass";
		if (!isSentinel && probability >= config.triage.suggest) action = "suggest";
		if (
			action === "suggest" &&
			settings.triageMode === "auto" &&
			type !== "multi" &&
			probability >= config.triage.autoAnswer &&
			determined >= config.triage.autoAnswer
		) {
			action = "auto";
		}
		const option = isSentinel ? undefined : q.options.find((o) => o.value === chosen);
		return {
			id: q.id,
			prompt: q.prompt,
			type,
			pick: isSentinel ? null : chosen,
			pickLabel: option ? (option.label ?? option.value) : null,
			probability,
			determined,
			action,
		};
	});

	return {
		toolCallId,
		questions: verdicts,
		auto: verdicts.length === input.questions.length && verdicts.every((v) => v.action === "auto"),
		latencyMs: call.latencyMs,
		cached: call.cached,
		answers: { ...call.result.answers },
		state,
	};
}

/** Mark Jev's picks as recommended and say so in the title. Mutates `input`. */
function applySuggestions(input: AskInput, verdict: TriageVerdict): number {
	let marked = 0;
	const notes: string[] = [];
	for (const v of verdict.questions) {
		if (v.action === "pass" || !v.pick) continue;
		const question = input.questions.find((q) => q.id === v.id);
		const option = question?.options.find((o) => o.value === v.pick);
		if (!option) continue;
		option.recommended = true;
		marked += 1;
		notes.push(`${v.pickLabel ?? v.pick} ${v.probability.toFixed(2)}`);
	}
	if (marked > 0) {
		const tag = `Jev suggests: ${notes.join(", ")}`;
		input.title = input.title ? `${input.title} · ${tag}` : tag;
	}
	return marked;
}

function summarise(verdict: TriageVerdict): string {
	return verdict.questions
		.map((v) => `${v.id}→${v.pick ?? ASK_USER} p=${v.probability.toFixed(2)} d=${v.determined.toFixed(2)}`)
		.join("; ");
}

interface StartedEvent {
	version: 1;
	flowId: string;
	toolCallId?: string;
	source: string;
	questions: { id: string; options: { value: string }[] }[];
}

interface CompletedEvent {
	flowId: string;
	toolCallId?: string;
	result: {
		cancelled: boolean;
		mode?: string;
		answers?: Record<string, { values?: string[]; labels?: string[]; customText?: string }>;
	};
}

interface SubmitResultEvent {
	requestId: string;
	flowId: string;
	ok: boolean;
	error?: string;
	message?: string;
}

export function registerTriage(
	pi: ExtensionAPI,
	client: JevClient,
	config: QuietAskConfig,
	settings: RuntimeSettings,
	history: HistoryStore,
): void {
	/** Verdicts eligible for auto-submit, consumed on `started`. */
	const pending = new Map<string, TriageVerdict>();
	/** Jev's pick per question for every judged call, consumed on `completed`. */
	const picksByCall = new Map<string, Map<string, string | null>>();
	let lastCtx: ExtensionContext | undefined;

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== ASK_USER_TOOL || settings.triageMode === "off") return undefined;
		if (!isAskInput(event.input)) return undefined;
		lastCtx = ctx;

		const verdict = await judgeAsk(client, config, settings, event.toolCallId, event.input, ctx);
		if (!verdict) return undefined; // fail open: the form opens as usual
		settings.counters.triageJudged += 1;

		const marked = applySuggestions(event.input, verdict);
		const action: TriageAction = verdict.auto ? "auto" : marked > 0 ? "suggest" : "pass";
		if (action === "auto") settings.counters.triageAuto += 1;
		else if (action === "suggest") settings.counters.triageSuggested += 1;
		else settings.counters.triagePassed += 1;

		if (verdict.auto) pending.set(event.toolCallId, verdict);
		picksByCall.set(event.toolCallId, new Map(verdict.questions.map((v) => [v.id, v.pick])));
		history.record(ctx, {
			kind: "triage",
			toolCallId: event.toolCallId,
			tool: ASK_USER_TOOL,
			action,
			summary: client.scrub(summarise(verdict)).slice(0, 160),
			answers: verdict.answers,
			latencyMs: verdict.latencyMs,
			cached: verdict.cached,
			mode: settings.triageMode,
			state: verdict.state,
		});
		if (ctx.hasUI) ctx.ui.setStatus("quiet", `triage ${action} ${verdict.cached ? "" : `${verdict.latencyMs.toFixed(0)}ms`}`);
		return undefined;
	});

	pi.events.on(PI_ASK_STARTED, (data) => {
		const event = data as StartedEvent;
		if (!event?.toolCallId || event.source !== "tool") return;
		const verdict = pending.get(event.toolCallId);
		if (!verdict || settings.triageMode !== "auto") return;
		pending.delete(event.toolCallId);

		const answers: Record<string, { values: string[]; note?: string }> = {};
		let first = true;
		for (const v of verdict.questions) {
			if (!v.pick) return; // should not happen for auto verdicts; be safe
			const answer: { values: string[]; note?: string } = { values: [v.pick] };
			if (first && config.triage.note) {
				answer.note = `Answered by pi-quiet-ask from the conversation (Jev p=${v.probability.toFixed(2)}, determined=${v.determined.toFixed(2)}); the user was not shown this form. Mention it in one line if it affects the result.`;
				first = false;
			}
			answers[v.id] = answer;
		}
		pi.events.emit(PI_ASK_SUBMIT, {
			version: 1,
			requestId: `pi-quiet-ask-${event.toolCallId}`,
			flowId: event.flowId,
			response: { kind: "answer", mode: "submit", answers },
		});
		if (lastCtx?.hasUI) {
			const picks = verdict.questions.map((v) => `${v.id}: ${v.pickLabel ?? v.pick}`).join(", ");
			lastCtx.ui.notify(`pi-quiet-ask answered for you — ${picks}. /quiet history triage to review.`, "info");
		}
	});

	pi.events.on(PI_ASK_SUBMIT_RESULT, (data) => {
		const event = data as SubmitResultEvent;
		if (!event?.requestId?.startsWith("pi-quiet-ask-") || event.ok) return;
		const toolCallId = event.requestId.slice("pi-quiet-ask-".length);
		history.resolve(toolCallId, {
			at: new Date().toISOString(),
			description: `auto-submit rejected by pi-ask (${event.error}): ${event.message ?? ""}`,
		});
		if (lastCtx?.hasUI) lastCtx.ui.notify(`pi-quiet-ask: auto-answer rejected (${event.error}); please answer the form.`, "warning");
	});

	pi.events.on(PI_ASK_COMPLETED, (data) => {
		const event = data as CompletedEvent;
		if (!event?.toolCallId) return;
		pending.delete(event.toolCallId);
		const picks = picksByCall.get(event.toolCallId);
		picksByCall.delete(event.toolCallId);
		const result = event.result;
		if (result.cancelled) {
			history.resolve(event.toolCallId, { at: new Date().toISOString(), description: "cancelled by user" });
			return;
		}
		const answers = result.answers ?? {};
		const final = Object.entries(answers)
			.map(([id, a]) => `${id}=${a.customText ?? (a.values ?? []).join("+")}`)
			.join(", ");
		// Did the human (or the auto-submit) end up where Jev pointed? Only
		// questions where Jev committed to an option count.
		let agreed: boolean | undefined;
		for (const [id, a] of Object.entries(answers)) {
			const pick = picks?.get(id);
			if (pick === undefined || pick === null) continue;
			const matched = (a.values ?? []).includes(pick) && !a.customText;
			agreed = agreed === undefined ? matched : agreed && matched;
		}
		history.resolve(event.toolCallId, {
			at: new Date().toISOString(),
			description: `final: ${final || "(no answer)"}`,
			agreed,
		});
	});
}
