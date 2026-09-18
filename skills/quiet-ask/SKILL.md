---
name: quiet-ask
license: MIT
description: >
  Work with the pi-quiet-ask extension so Jev can judge this session.
  Use whenever tools run, a claim of "done" is about to be made, ask_user
  or jev_ask is called, a user pack is written, or the agent is deciding
  whether to ask the human. Teaches closed questions, closed loops,
  observable traces, and sending only relevant state — not more state.
---

# Work with pi-quiet-ask

This session has a quiet decision layer. **Jev never sees your thoughts.**
It sees only the state the harness built from your tools, your last
message, and the evidence ledger. Most packs fire on hooks; you do not
call Jev yourself. `jev_ask` is the exception.

The product is a **closed loop**: observe → closed question → rule →
act or record → observe again. Your job is to leave traces the loop
can read, and to ask Jev only closed questions with relevant state.

When a set already lives in the evidence ledger (changed files, failed
commands, stale checks), do not invent its members. Call `jev_choose`
with the space name. Packs may use `"optionsFrom": "verify_targets"`
the same way: Jev picks an observed id or `none`.

## Leave traces the loop can see

- Change files with `write` / `edit`. Do not "apply" a patch only in
  prose. `honest_finish` and the ledger count `run_edits` from those tools.
- Check work with `bash` (tests, typecheck, lint, build, or actually
  running the program) **after** the last edit. A sentence that says
  "it works" is not verification. The ledger marks a check stale as
  soon as you edit again.
- If you cannot verify, say so in the final message. Hedging is a
  closed fact Jev can read; a fake "done" is what the loop steers against.
- Prefer one bash command that is the real check. Do not retry the same
  failing command unchanged — `stuck` will fire, and you should change
  approach or ask the user.

## Closed questions only

A closed question has a finite answer: yes-probability (`noul`), one
label (`choice`), or a position on ordered levels (`score`). Never ask
Jev to "explain", "summarize", or "decide what to do".

When you call `jev_ask`, `jev_choose`, or write a pack question:

1. Ask about **what the state says**, not what a reader should conclude.
2. One judgement per question. Split "is it a test failure, and is it
   ours?" into two questions.
3. Every `choice` needs a no-match option (`other` / `ask_user` / `none`).
4. Score levels describe **situations**, not degrees ("tests failed after
   the last edit"), not "low / medium / high".
5. Put policy in the rule (`if verified <= 0.35 then steer`), not in the
   question text.

## State: relevant, not large

Quality comes from **fit**, not size. Jev is a short-state model.
Dumping the repo, the system prompt, or a full log dilutes the signal
and makes it read the wrong sentence.

Send only what the question needs:

| Question | State that helps | State that hurts |
|---|---|---|
| Is this command destructive? | `tool`, `arguments`, the user request | Full conversation, command output |
| Did the run verify the claim? | Tool briefs / evidence facts (`files_changed`, `verified_after_change`) | The whole transcript |
| Which option does context already pick? | Recent user/assistant turns, project facts | Bash dumps, unrelated files |
| What phase is this turn? | This turn's tools + assistant text + path so far | Earlier run's full outputs |

For `jev_ask`, pass a small JSON object or a short excerpt (a diff hunk,
a test tail, a single message). If you have more than a few hundred
tokens of state, you have not cut enough. The harness will redact
secrets and truncate anyway — do not rely on that as a license to paste.

## Asking the user (`ask_user`)

Triage asks Jev whether the conversation **already** determines the
answer. Help it:

- Use single-choice questions with explicit options when you can.
- Do not ask what the lockfile, config, or last user message already
  answers. Just use that fact.
- Do ask preferences, deletions, and policy. Those stay with the human
  even if you are confident.
- Multi-select and free text are never auto-answered. Use them when the
  answer cannot be one label.

## Writing a pack

A pack is hook + filter + state sources + questions + rules. Copy a
built-in from the extension README, change `vars` and the question
wording, drop JSON in `.pi/pi-quiet-ask/packs/` or
`~/.pi/agent/pi-quiet-ask/packs/`. Ship new intervening packs in
`shadow` until `/quiet history` shows the numbers are right.

Rules test headline values (`destructive >= vars.destructive`,
`intent == "debug"`, `not verified_after_change`). Unknown paths are
false. Do not invent actions outside `block`, `confirm`, `annotate`,
`steer`, `set_thinking`, `set_tools`, `warn`, `status`, `tag`, `allow`.
A Choice may use `"optionsFrom": "verify_targets"` (or `unverified_files`,
`recent_failures`, `commands`, `argument_paths`) instead of a fixed
`options` map; the harness rebuilds the set from the ledger each time.

## Do not

- Call `jev_ask` to write the code, to replace a tool you should run, or
  to invent the members of a set the ledger already has. Use `jev_choose`.
- Paste secrets, `.env`, or tokens into `jev_ask` state. Redaction is
  a backstop, not the plan.
- Claim completion, then skip the check because "it should work".
- Retry an identical failing command hoping the loop will not notice.
- Grow state "so Jev has more context". Cut until only the question
  remains answerable.
