/**
 * Questions for the one judge that is not a pack: triage.
 *
 * Gate, output, intent, honest_finish, and stuck live in `packs/` as
 * declarative packs. Triage cannot be a pack because its questions are
 * built from the `ask_user` payload at call time and its actions (mark a
 * recommended option, auto-submit through pi-ask's event contract) are
 * specific to that tool.
 *
 * Rules that shaped every question in this package (from TypeSafe's docs
 * and our own `bench/` runs): ask one thing per question, describe
 * situations rather than degrees in score rubrics, include a no-match
 * option in every choice, and ask about what the state says rather than
 * what a reader would conclude.
 */

import { noul } from "@typesafe-ai/sdk";

/** Sentinel option meaning "the context does not decide this". */
export const ASK_USER = "ask_user";

/**
 * The first live triage miss was p=0.89 / d=0.88 on a message that already
 * said "use pnpm" *and* "call ask_user". A one-line guide treated the
 * tool-call instruction as doubt. These spell out what counts as a
 * decision and what to ignore.
 */
export const TRIAGE_CHOICE_INSTRUCTIONS =
	"Using only `user_request`, `last_user_message`, and `recent`, pick the option those fields already name as the answer to this question (`questions[<id>].prompt`). " +
	"Pick an option when the user named that option's value or a common alias as the choice (\"use pnpm\", \"I already decided X\", \"only X\"), or when one project fact in `recent` uniquely selects it (lockfile, packageManager, a prior answer). " +
	"Pick ask_user when the user listed options without choosing, two options still fit, or this is a new preference with no prior statement. " +
	"The agent calling ask_user, or being told to call it, is not a reason to pick ask_user. " +
	"Ignore option descriptions that only editorialize (default, recommended, preferred, popular). Do not infer taste.";

export const TRIAGE_DETERMINED = noul(
	"Do `user_request`, `last_user_message`, and `recent` already determine the answer to this question (`questions[<id>].prompt`), so the user does not need to see the form? " +
		"Already determined: the user named one option (or alias) as the choice, or one project fact uniquely selects one option. " +
		"Not determined: the user listed options without choosing, contradicted themselves, or this is a new preference with no prior statement. " +
		"The agent being told to call ask_user is not evidence the user must be asked. Judge only what the state already says.",
);
