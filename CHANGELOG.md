# Changelog

## [0.2.0] - 2026-09-17

Renamed from `pi-typesafe` to `pi-quiet-ask`. Config, commands, and the
extension entry changed; nothing from 0.1.0 is kept as-is.

### Added

- **Rule engine.** Judges are *packs*: a pi hook, a `when` filter, named
  state sources, typed Jev questions, and ordered rules whose conditions
  are expressions over the answers (`destructive >= vars.destructive`,
  `failure_class == "transient" and failure_class.confidence >= 0.6`) and
  whose actions come from a closed vocabulary (`block`, `confirm`,
  `annotate`, `steer`, `set_thinking`, `set_tools`, `warn`, `status`,
  `tag`, `allow`). Per-pack `shadow` / `enforce`. User packs as JSON in
  `~/.pi/agent/pi-quiet-ask/packs/`, `<project>/.pi/pi-quiet-ask/packs/`,
  or inline in the config; `packs.<name>` overrides `mode`, `vars`,
  `when`, `cacheSeconds`, `enabled` without copying.
- Built-in packs `gate` (tool_call), `output` (tool_result), `intent`
  (before_agent_start), `honest_finish` (agent_end), `stuck` (turn_end).
- **Task graph**: a fixed clarify → explore → plan → implement → verify →
  report state machine; Jev assigns each turn a phase plus progress and
  drift; HUD widget; invariants `report_without_verify`, `explore_loop`,
  `drift`; `/quiet graph`.
- **Triage** of `@eko24ive/pi-ask` `ask_user` calls through pi-ask's
  event contract: mark Jev's pick as recommended, auto-submit above
  0.9/0.9, record the final answer and whether it agreed with Jev.
- `jev_ask` tool for the model.
- Decision history: `pi-quiet-ask:decision` session entries plus
  `~/.pi/agent/pi-quiet-ask/history.jsonl`, with resolved outcomes;
  `/quiet history [kind]`.
- Layered config (`~/.pi/agent/pi-quiet-ask.json`, `<project>/.pi/pi-quiet-ask.json`),
  key resolution from env / config / key file / `.env`, secret redaction
  with counts, truncation, cache with in-flight sharing, rate-limited
  error reporting.
- `/quiet` command: status, on|off, packs, pack, mode, triage, graph,
  last, check, history.

### Removed

- The bundled `question` tool (pi-ask does this better); `/jev`;
  `--jev-dry-run`; `PI_TYPESAFE_DEBUG_LOG` (history replaces it).

## [0.1.0] - 2026-09-17

### Added

- `tool_call` gate: every non-read-only tool call is judged by Jev as
  `allow / confirm / block`; policy thresholds live in code
  (`questions.ts`). Fails open on Jev errors. `--jev-dry-run` observes
  without blocking.
- `question` tool: before showing the dialog, Jev checks whether the
  conversation already determines the answer. Confident answers are
  returned on the user's behalf and recorded with `pi.appendEntry`;
  weaker suggestions are shown first in the dialog.
- `/jev` command: stats, `dry on|off`, `auto on|off`.
- `PI_TYPESAFE_DEBUG_LOG` to record every Jev request and response.
- Vendored `typesafe-ai` agent skill so the main LLM can write TypeSafe
  code correctly.
