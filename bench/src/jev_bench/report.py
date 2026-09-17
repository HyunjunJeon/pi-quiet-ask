"""Render metrics as a Rich table (terminal) and Markdown (file)."""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Sequence

from rich.console import Console
from rich.table import Table

from jev_bench.metrics import ProviderMetrics
from jev_bench.schema import Item, Judgment


def _pct(value: float | None) -> str:
    return "-" if value is None else f"{value * 100:.0f}%"


def print_table(
    task: str, metrics: Sequence[ProviderMetrics], console: Console
) -> None:
    """Print one comparison table for ``task``."""
    table = Table(title=f"{task}  (n_items x repeats = calls)")
    table.add_column("provider", style="bold")
    table.add_column("calls", justify="right")
    table.add_column("choice acc", justify="right")
    table.add_column("noul acc", justify="right")
    table.add_column("brier", justify="right")
    table.add_column("ECE", justify="right")
    table.add_column("agree", justify="right")
    table.add_column("sel@0.7 cov/acc", justify="right")
    table.add_column("sel@0.9 cov/acc", justify="right")
    table.add_column("p50 ms", justify="right")
    table.add_column("p95 ms", justify="right")
    table.add_column("$/call", justify="right")
    table.add_column("schema viol", justify="right")
    for m in metrics:
        sel = {round(s.threshold, 1): s for s in m.selective}
        table.add_row(
            m.provider,
            str(m.n_calls),
            _pct(m.choice_accuracy),
            _pct(m.noul_accuracy),
            f"{m.noul_brier:.3f}",
            f"{m.ece:.3f}",
            _pct(m.repeat_agreement),
            f"{_pct(sel[0.7].coverage)}/{_pct(sel[0.7].accuracy)}",
            f"{_pct(sel[0.9].coverage)}/{_pct(sel[0.9].accuracy)}",
            f"{m.latency_p50_ms:.0f}",
            f"{m.latency_p95_ms:.0f}",
            f"{m.cost_per_call_usd * 1000:.3f}m",
            _pct(m.schema_violation_rate),
        )
    console.print(table)


def markdown_report(
    task: str,
    metrics: Sequence[ProviderMetrics],
    items: Sequence[Item],
    judgments: dict[str, list[Judgment]],
) -> str:
    """Return a Markdown section with the summary table and per-item view."""
    lines = [f"## {task}", ""]
    lines.append(
        "| provider | calls | choice acc | noul acc | Brier | ECE | "
        "agree | sel@0.7 cov/acc | sel@0.9 cov/acc | p50 ms | p95 ms | "
        "$/call | schema viol |"
    )
    lines.append("|" + "---|" * 13)
    for m in metrics:
        sel = {round(s.threshold, 1): s for s in m.selective}
        lines.append(
            f"| {m.provider} | {m.n_calls} | {_pct(m.choice_accuracy)} | "
            f"{_pct(m.noul_accuracy)} | {m.noul_brier:.3f} | {m.ece:.3f} | "
            f"{_pct(m.repeat_agreement)} | "
            f"{_pct(sel[0.7].coverage)}/{_pct(sel[0.7].accuracy)} | "
            f"{_pct(sel[0.9].coverage)}/{_pct(sel[0.9].accuracy)} | "
            f"{m.latency_p50_ms:.0f} | {m.latency_p95_ms:.0f} | "
            f"${m.cost_per_call_usd:.6f} | {_pct(m.schema_violation_rate)} |"
        )
    lines.append("")
    lines.append("### Per-item majority answer (gold in brackets)")
    lines.append("")
    providers = [m.provider for m in metrics]
    lines.append("| item | gold | " + " | ".join(providers) + " |")
    lines.append("|" + "---|" * (len(providers) + 2))
    majority: dict[str, dict[str, str]] = defaultdict(dict)
    for provider, batch in judgments.items():
        per_item: dict[str, list[str]] = defaultdict(list)
        for j in batch:
            per_item[j.item_id].append(j.choice or "ERR")
        for item_id, choices in per_item.items():
            top = max(set(choices), key=choices.count)
            majority[item_id][provider] = top
    for item in items:
        cells = []
        for provider in providers:
            answer = majority[item.id].get(provider, "-")
            mark = "" if answer == item.gold_choice else " x"
            cells.append(f"{answer}{mark}")
        lines.append(
            f"| {item.id} | {item.gold_choice} | " + " | ".join(cells) + " |"
        )
    lines.append("")
    return "\n".join(lines)
