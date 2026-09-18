/**
 * State sources: the named pieces of pi's world a pack can send to Jev.
 *
 * A pack lists sources by name; this module builds the object. Everything
 * is then redacted and truncated by `prepareState` in the engine, so a
 * source may return raw text. Sources that do not apply to the current hook
 * are simply absent.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildConversationState } from "../context.ts";
import type { SpaceFacts } from "../space.ts";
import type { StateSource } from "./pack.ts";

/** What a hook handed us, flattened to what sources need. */
export interface HookInput {
	hook: string;
	tool?: string;
	toolCallId?: string;
	arguments?: unknown;
	/** Tool result text (tool_result). */
	output?: string;
	isError?: boolean;
	/** User prompt (before_agent_start). */
	prompt?: string;
	/** Assistant message for this turn (turn_end) or the whole run (agent_end). */
	messages?: unknown[];
	/** This turn's tool results (turn_end). */
	toolResults?: unknown[];
	turnIndex?: number;
}

export interface ToolBrief {
	tool: string;
	args: string;
	is_error?: boolean;
	output_head?: string;
}

/** Supplied by the graph tracker so packs can ask about the workflow so far. */
export type GraphSnapshotProvider = () => unknown;

/** Supplied by the evidence ledger: a compact state view plus plain facts for rules. */
export type EvidenceSnapshotProvider = () => {
	state: Record<string, unknown>;
	facts: Record<string, unknown>;
	space?: SpaceFacts;
};

export interface StateProviders {
	graph?: GraphSnapshotProvider;
	evidence?: EvidenceSnapshotProvider;
}

const MAX_BRIEF_ARGS = 200;
const MAX_OUTPUT_HEAD = 300;
const MAX_RECENT_FAILURES = 5;

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block: unknown) => {
			const record = block as Record<string, unknown> | null;
			return record && record.type === "text" && typeof record.text === "string" ? record.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

function briefArgs(args: unknown): string {
	const record = (args ?? {}) as Record<string, unknown>;
	if (typeof record.command === "string") return record.command.slice(0, MAX_BRIEF_ARGS);
	if (typeof record.path === "string") return record.path;
	const json = JSON.stringify(args ?? {});
	return json.length > MAX_BRIEF_ARGS ? `${json.slice(0, MAX_BRIEF_ARGS)}…` : json;
}

/** Tool calls in an assistant message paired with their results. */
export function toolBriefs(messages: readonly unknown[]): ToolBrief[] {
	const calls = new Map<string, ToolBrief>();
	const order: string[] = [];
	for (const raw of messages) {
		const message = raw as { role?: string; content?: unknown; toolCallId?: string; isError?: boolean };
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content as Record<string, unknown>[]) {
				if (block.type !== "toolCall") continue;
				const id = String(block.id ?? "");
				calls.set(id, { tool: String(block.name), args: briefArgs(block.arguments) });
				order.push(id);
			}
		} else if (message.role === "toolResult" && message.toolCallId) {
			const brief = calls.get(message.toolCallId);
			if (!brief) continue;
			brief.is_error = message.isError === true;
			const head = textOf(message.content).replace(/\s+/g, " ").trim();
			if (head) brief.output_head = head.length > MAX_OUTPUT_HEAD ? `${head.slice(0, MAX_OUTPUT_HEAD)}…` : head;
		}
	}
	return order.map((id) => calls.get(id)).filter((b): b is ToolBrief => b !== undefined);
}

/** Last assistant text in a list of messages. */
export function lastAssistantText(messages: readonly unknown[]): string {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i] as { role?: string; content?: unknown };
		if (message.role !== "assistant") continue;
		const text = textOf(message.content);
		if (text.trim()) return text;
	}
	return "";
}

/** Messages of the current run: everything after the last real user message on the branch. */
export function currentRunMessages(ctx: ExtensionContext): unknown[] {
	const messages: unknown[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: string };
		if (message.role === "user") messages.length = 0;
		messages.push(message);
	}
	return messages;
}

function recentFailures(ctx: ExtensionContext): ToolBrief[] {
	const all = toolBriefs(
		ctx.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "message")
			.map((entry) => (entry as { message: unknown }).message),
	);
	return all.filter((b) => b.is_error).slice(-MAX_RECENT_FAILURES);
}

export interface BuiltState {
	state: Record<string, unknown>;
	/** Extra scope values rules may test (tool, is_error, turn_index…). */
	scope: Record<string, unknown>;
}

export function buildState(
	sources: readonly StateSource[],
	input: HookInput,
	ctx: ExtensionContext,
	providers: StateProviders,
	outputChars: number,
): BuiltState {
	const state: Record<string, unknown> = {};
	const scope: Record<string, unknown> = {
		tool: input.tool,
		is_error: input.isError ?? false,
		turn_index: input.turnIndex ?? 0,
		has_ui: ctx.hasUI,
		// Ledger facts are always in scope; they are cheap and let rules
		// pair a probability with what actually happened.
		...(providers.evidence?.().facts ?? {}),
	};
	let conversation: ReturnType<typeof buildConversationState> | undefined;
	const convo = () => (conversation ??= buildConversationState(ctx));
	// Deterministic facts about tool use go into the rule scope (not to Jev)
	// so rules can combine a probability with a hard count, e.g.
	// `claims_done >= 0.7 and run_edits > 0`.
	const facts = (prefix: string, briefs: ToolBrief[]) => {
		scope[`${prefix}_tool_count`] = briefs.length;
		scope[`${prefix}_edits`] = briefs.filter((b) => b.tool === "write" || b.tool === "edit").length;
		scope[`${prefix}_errors`] = briefs.filter((b) => b.is_error).length;
	};

	for (const source of sources) {
		switch (source) {
			case "cwd":
				state.cwd = ctx.cwd;
				break;
			case "user_request":
				state.user_request = convo().user_request;
				break;
			case "last_user_message":
				state.last_user_message = convo().last_user_message;
				break;
			case "recent_turns":
				state.recent_turns = convo().recent;
				break;
			case "tool":
				if (input.tool) state.tool = input.tool;
				break;
			case "arguments":
				if (input.arguments !== undefined) state.arguments = input.arguments;
				break;
			case "output":
				if (input.output !== undefined) state.output = input.output.slice(0, outputChars);
				break;
			case "is_error":
				if (input.isError !== undefined) state.is_error = input.isError;
				break;
			case "prompt":
				if (input.prompt !== undefined) state.prompt = input.prompt;
				break;
			case "assistant_text":
				if (input.messages) state.assistant_text = lastAssistantText(input.messages);
				break;
			case "turn_tools": {
				if (!input.messages) break;
				const briefs = toolBriefs([...input.messages, ...(input.toolResults ?? [])]);
				state.turn_tools = briefs;
				facts("turn", briefs);
				break;
			}
			case "run_tools": {
				const briefs = toolBriefs(input.hook === "agent_end" && input.messages ? input.messages : currentRunMessages(ctx));
				state.run_tools = briefs;
				facts("run", briefs);
				break;
			}
			case "recent_failures":
				state.recent_failures = recentFailures(ctx);
				break;
			case "turn_index":
				if (input.turnIndex !== undefined) state.turn_index = input.turnIndex;
				break;
			case "graph":
				if (providers.graph) state.graph = providers.graph();
				break;
			case "evidence":
				if (providers.evidence) state.evidence = providers.evidence().state;
				break;
		}
	}
	return { state, scope };
}
