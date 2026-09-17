"""Unit tests for metric aggregation and probability normalisation."""

from __future__ import annotations

import pytest

from jev_bench.metrics import compute_metrics
from jev_bench.schema import Item, Judgment, Task, normalise_probabilities


def _item(item_id: str, gold: str, gold_noul: bool = True) -> Item:
    return Item(
        id=item_id,
        task=Task.TOOL_GATE,
        state="x",
        choice_instructions="q",
        criteria={"a": None, "b": None, "c": None},
        noul_instructions="n",
        gold_choice=gold,
        gold_noul=gold_noul,
    )


def _judgment(
    item_id: str,
    choice: str | None,
    probs: dict[str, float],
    noul: float,
    repeat: int = 0,
    schema_ok: bool = True,
) -> Judgment:
    return Judgment(
        provider="p",
        item_id=item_id,
        repeat=repeat,
        choice=choice,
        probabilities=probs,
        noul=noul,
        latency_ms=100.0,
        cost_usd=0.001,
        schema_ok=schema_ok,
    )


def test_normalise_fills_missing_and_renormalises() -> None:
    """Missing options become 0 and the result sums to 1."""
    probs = normalise_probabilities({"a": 2, "b": "2"}, ["a", "b", "c"])
    assert probs == {"a": 0.5, "b": 0.5, "c": 0.0}


def test_normalise_all_zero_stays_zero() -> None:
    """A degenerate distribution must not divide by zero."""
    probs = normalise_probabilities({}, ["a", "b"])
    assert probs == {"a": 0.0, "b": 0.0}


def test_entropy_confidence_extremes() -> None:
    """One-hot is fully confident; uniform has zero confidence."""
    one_hot = _judgment("i", "a", {"a": 1.0, "b": 0.0, "c": 0.0}, 0.5)
    uniform = _judgment("i", "a", {"a": 1 / 3, "b": 1 / 3, "c": 1 / 3}, 0.5)
    assert one_hot.entropy_confidence == pytest.approx(1.0)
    assert uniform.entropy_confidence == pytest.approx(0.0)


def test_compute_metrics_basic_counts() -> None:
    """Accuracy, agreement, selective coverage and error rate line up."""
    items = [_item("i1", "a"), _item("i2", "b", gold_noul=False)]
    judgments = [
        _judgment("i1", "a", {"a": 0.9, "b": 0.05, "c": 0.05}, 0.9, 0),
        _judgment("i1", "a", {"a": 0.9, "b": 0.05, "c": 0.05}, 0.9, 1),
        _judgment("i2", "c", {"a": 0.4, "b": 0.3, "c": 0.3}, 0.2, 0),
        _judgment("i2", None, {}, 0.5, 1, schema_ok=False),
    ]
    metrics = compute_metrics("p", items, judgments)

    assert metrics.n_calls == 4
    # 2 correct out of 3 usable answers.
    assert metrics.choice_accuracy == pytest.approx(2 / 3)
    # noul >= 0.5 vs gold: (0.9,T) ok, (0.9,T) ok, (0.2,F) ok, (0.5,F) wrong
    assert metrics.noul_accuracy == pytest.approx(3 / 4)
    # i1 fully agrees; i2 splits 1/2 -> mean 0.75
    assert metrics.repeat_agreement == pytest.approx(0.75)
    assert metrics.error_rate == pytest.approx(1 / 4)
    assert metrics.schema_violation_rate == pytest.approx(1 / 4)
    # {0.9, 0.05, 0.05} has entropy confidence ~0.64; {0.4, 0.3, 0.3} ~0.01.
    # So a 0.5 gate accepts only the two i1 answers, a 0.9 gate none.
    mid = next(s for s in metrics.selective if s.threshold == 0.5)
    assert mid.coverage == pytest.approx(2 / 4)
    assert mid.accuracy == pytest.approx(1.0)
    high = next(s for s in metrics.selective if s.threshold == 0.9)
    assert high.coverage == 0.0
    assert high.accuracy is None
