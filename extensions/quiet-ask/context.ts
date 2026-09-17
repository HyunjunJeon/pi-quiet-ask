/**
 * Turn the current session branch into a compact `context` object for Jev.
 *
 * Jev reads structured state well, so the user's original request, the
 * most recent user message, and the last few turns are kept as separate
 * fields. Nothing here reaches the main LLM; it only feeds the side channel,
 * and it is redacted/truncated again by `prepareState` before sending.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const MAX_RECENT_TURNS = 12;
const MAX_CHARS_PER_TURN = 600;
const MAX_CHARS_LAST_USER = 1200;

export interface ConversationState {
	/** First user message on the branch. */
	user_request: string;
	/** Most recent user message (first 1200 chars). */
	last_user_message: string;
	/** `role: text` for the last N turns, tool calls included as one line. */
	recent: string[];
}

function clip(text: string, limit: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block: unknown) => {
			if (!block || typeof block !== "object") return "";
			const record = block as Record<string, unknown>;
			if (record.type === "text" && typeof record.text === "string") return record.text;
			if (record.type === "toolCall") return `call ${String(record.name)} ${JSON.stringify(record.arguments ?? {})}`;
			if (record.type === "toolResult") return `result ${textOf(record.content)}`;
			return "";
		})
		.filter(Boolean)
		.join(" ");
}

export function buildConversationState(ctx: ExtensionContext): ConversationState {
	let userRequest = "";
	let lastUser = "";
	const turns: string[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = entry.message as { role: string; content: unknown };
		// The system prompt is long, identical every turn, and says nothing about this task.
		if (message.role === "system") continue;
		const text = textOf(message.content);
		if (!text) continue;
		if (message.role === "user") {
			if (!userRequest) userRequest = clip(text, MAX_CHARS_PER_TURN);
			lastUser = clip(text, MAX_CHARS_LAST_USER);
		}
		turns.push(`${message.role}: ${clip(text, MAX_CHARS_PER_TURN)}`);
	}
	return { user_request: userRequest, last_user_message: lastUser, recent: turns.slice(-MAX_RECENT_TURNS) };
}
