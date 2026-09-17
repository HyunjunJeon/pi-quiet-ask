/**
 * Built-in packs, in the order they are loaded. A user pack with the same
 * name replaces the built-in; `packs.<name>` in the config overrides
 * `enabled`, `mode`, `cacheSeconds`, `vars`, and `when` without a copy.
 */

import type { PackSpec } from "../engine/pack.ts";
import { GATE_PACK } from "./gate.ts";
import { HONEST_FINISH_PACK } from "./honest-finish.ts";
import { INTENT_PACK } from "./intent.ts";
import { OUTPUT_PACK } from "./output.ts";
import { STUCK_PACK } from "./stuck.ts";

export const BUILTIN_PACKS: PackSpec[] = [GATE_PACK, OUTPUT_PACK, INTENT_PACK, HONEST_FINISH_PACK, STUCK_PACK];
