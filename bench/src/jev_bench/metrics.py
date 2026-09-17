"""Aggregate judgments into per-provider metrics.

The metrics answer four questions a harness author cares about:

* Is it right? (choice accuracy, Noul Brier score)
* Does it know when it is right? (ECE, selective accuracy at a threshold)
* Does it give the same answer twice? (repeat agreement)
* What does it cost? (latency percentiles, USD, schema-violation rate)

Selective accuracy is the headline for the "auto-answer the agent's
question" use case: at threshold ``t`` we only accept answers whose shared
confidence is at least ``t`` and report how many we accepted (coverage) and
how many of those were right.
"""

from __future__ import annotations

import statistics
from collections import Counter, defaultdict
from collections.abc import Iterable

from pydantic import BaseModel

from jev_bench.schema import Item, Judgment

SELECTIVE_THRESHOLDS: tuple[float, ...] = (0.5, 0.7, 0.9)
ECE_BINS = 5


class SelectivePoint(BaseModel):
    """Coverage / accuracy after gating on confidence."""

    threshold: float
    coverage: float
    accuracy: float | None


class ProviderMetrics(BaseModel):
    """Everything we report for one provider on one task."""

    provider: str
    n_calls: int
    n_items: int
    choice_accuracy: float
    noul_accuracy: float
    noul_brier: float
    ece: float
    repeat_agreement: float
    selective: list[SelectivePoint]
    latency_p50_ms: float
    latency_p95_ms: float
    cost_total_usd: float
    cost_per_call_usd: float
    schema_violation_rate: float
    error_rate: float


def _percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, round((len(ordered) - 1) * pct))
    return ordered[index]


def _ece(pairs: list[tuple[float, bool]], bins: int = ECE_BINS) -> float:
    """Compute expected calibration error over equal-width bins."""
    if not pairs:
        return 0.0
    buckets: dict[int, list[tuple[float, bool]]] = defaultdict(list)
    for confidence, correct in pairs:
        index = min(bins - 1, int(confidence * bins))
        buckets[index].append((confidence, correct))
    total = len(pairs)
    error = 0.0
    for bucket in buckets.values():
        mean_conf = statistics.fmean(c for c, _ in bucket)
        mean_acc = statistics.fmean(1.0 if ok else 0.0 for _, ok in bucket)
        error += abs(mean_conf - mean_acc) * len(bucket) / total
    return error


def _repeat_agreement(judgments: Iterable[Judgment]) -> float:
    """Mean fraction of repeats that agree with the per-item majority."""
    by_item: dict[str, list[str | None]] = defaultdict(list)
    for judgment in judgments:
        by_item[judgment.item_id].append(judgment.choice)
    scores: list[float] = []
    for choices in by_item.values():
        if len(choices) < 2:
            continue
        top = Counter(choices).most_common(1)[0][1]
        scores.append(top / len(choices))
    return statistics.fmean(scores) if scores else 1.0


def compute_metrics(
    provider: str,
    items: list[Item],
    judgments: list[Judgment],
) -> ProviderMetrics:
    """Aggregate ``judgments`` for ``provider`` against ``items``."""
    gold = {item.id: item for item in items}
    usable = [j for j in judgments if j.choice is not None]

    choice_hits = [j.choice == gold[j.item_id].gold_choice for j in usable]
    choice_accuracy = statistics.fmean(choice_hits) if choice_hits else 0.0

    noul_pairs = [
        (j.noul, gold[j.item_id].gold_noul)
        for j in judgments
        if j.noul is not None
    ]
    noul_accuracy = (
        statistics.fmean((p >= 0.5) == y for p, y in noul_pairs)
        if noul_pairs
        else 0.0
    )
    noul_brier = (
        statistics.fmean((p - float(y)) ** 2 for p, y in noul_pairs)
        if noul_pairs
        else 1.0
    )

    calibration_pairs = [
        (j.max_prob, j.choice == gold[j.item_id].gold_choice) for j in usable
    ]

    selective: list[SelectivePoint] = []
    for threshold in SELECTIVE_THRESHOLDS:
        accepted = [j for j in usable if j.entropy_confidence >= threshold]
        coverage = len(accepted) / len(judgments) if judgments else 0.0
        accuracy = (
            statistics.fmean(
                j.choice == gold[j.item_id].gold_choice for j in accepted
            )
            if accepted
            else None
        )
        selective.append(
            SelectivePoint(
                threshold=threshold, coverage=coverage, accuracy=accuracy
            )
        )

    latencies = [j.latency_ms for j in judgments]
    cost_total = sum(j.cost_usd for j in judgments)
    return ProviderMetrics(
        provider=provider,
        n_calls=len(judgments),
        n_items=len(items),
        choice_accuracy=choice_accuracy,
        noul_accuracy=noul_accuracy,
        noul_brier=noul_brier,
        ece=_ece(calibration_pairs),
        repeat_agreement=_repeat_agreement(judgments),
        selective=selective,
        latency_p50_ms=_percentile(latencies, 0.5),
        latency_p95_ms=_percentile(latencies, 0.95),
        cost_total_usd=cost_total,
        cost_per_call_usd=cost_total / len(judgments) if judgments else 0.0,
        schema_violation_rate=(
            sum(not j.schema_ok for j in judgments) / len(judgments)
            if judgments
            else 0.0
        ),
        error_rate=(
            sum(j.choice is None for j in judgments) / len(judgments)
            if judgments
            else 0.0
        ),
    )
