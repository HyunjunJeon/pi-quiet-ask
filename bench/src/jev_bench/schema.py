"""Shared data types for benchmark items and provider judgments."""

from __future__ import annotations

import math
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field

type JsonState = str | dict[str, Any] | list[Any]


class Task(StrEnum):
    """Benchmark task families."""

    TOOL_GATE = "tool_gate"
    AGENT_QUESTION = "agent_question"


class Item(BaseModel):
    """One benchmark case.

    Both providers see ``state`` and must answer:

    * a Choice over ``criteria`` guided by ``choice_instructions``
    * a Noul (yes-probability) for ``noul_instructions``
    """

    id: str
    task: Task
    state: JsonState
    choice_instructions: str
    criteria: dict[str, str | None]
    noul_instructions: str
    gold_choice: str
    gold_noul: bool
    notes: str = ""


class Judgment(BaseModel):
    """A provider's answer for one item, normalised across providers."""

    provider: str
    item_id: str
    repeat: int
    choice: str | None
    probabilities: dict[str, float] = Field(default_factory=dict)
    noul: float | None
    native_confidence: float | None = None
    latency_ms: float
    cost_usd: float
    input_tokens: int | None = None
    output_tokens: int | None = None
    schema_ok: bool
    error: str | None = None

    @property
    def max_prob(self) -> float:
        """Highest option probability; 0 when the answer was unusable."""
        if not self.probabilities:
            return 0.0
        return max(self.probabilities.values())

    @property
    def entropy_confidence(self) -> float:
        """1 minus normalised Shannon entropy of the option distribution.

        Used as the *shared* confidence measure so that Jev's native
        ``confidence`` and an LLM's self-reported probabilities are compared
        with one formula. Returns 1.0 for a one-hot distribution and 0.0 for
        a uniform one.
        """
        probs = [p for p in self.probabilities.values() if p > 0]
        n = len(self.probabilities)
        if n <= 1 or not probs:
            return 0.0
        entropy = -sum(p * math.log(p) for p in probs)
        return max(0.0, 1.0 - entropy / math.log(n))


def normalise_probabilities(
    raw: dict[str, Any], options: list[str]
) -> dict[str, float]:
    """Clamp, fill missing options with 0 and renormalise to sum 1.

    LLMs frequently return distributions that do not sum to one or omit
    options. Jev never does, but running both through the same function
    keeps the metric code provider-agnostic.
    """
    cleaned: dict[str, float] = {}
    for option in options:
        value = raw.get(option, 0.0)
        try:
            number = float(value)
        except (TypeError, ValueError):
            number = 0.0
        cleaned[option] = max(0.0, number)
    total = sum(cleaned.values())
    if total <= 0:
        return {option: 0.0 for option in options}
    return {option: value / total for option, value in cleaned.items()}
