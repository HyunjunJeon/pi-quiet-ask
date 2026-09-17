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

export const TRIAGE_CHOICE_INSTRUCTIONS =
	"The coding agent wants to ask the user this question before continuing. Using only the conversation and project facts in `context`, pick the option the context already determines. If the context does not clearly determine one option, pick ask_user.";

export const TRIAGE_DETERMINED = noul(
	"Does the conversation and project context already determine the answer to this question, so the user does not need to be asked?",
);
