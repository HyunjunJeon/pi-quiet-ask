"""Run every provider over every item, ``repeats`` times, concurrently."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Sequence
from pathlib import Path

from rich.progress import Progress

from jev_bench.providers.base import Provider
from jev_bench.schema import Item, Judgment


async def run_provider(
    provider: Provider,
    items: Sequence[Item],
    repeats: int,
    concurrency: int,
    progress: Progress | None = None,
) -> list[Judgment]:
    """Judge all items ``repeats`` times with bounded concurrency.

    Concurrency is bounded per provider so that a slow LLM does not
    starve the others and so we stay under provider rate limits.
    """
    semaphore = asyncio.Semaphore(concurrency)
    task_id = (
        progress.add_task(provider.name, total=len(items) * repeats)
        if progress
        else None
    )

    async def one(item: Item, repeat: int) -> Judgment:
        async with semaphore:
            judgment = await provider.judge(item, repeat)
        if progress is not None and task_id is not None:
            progress.advance(task_id)
        return judgment

    coroutines = [
        one(item, repeat) for item in items for repeat in range(repeats)
    ]
    return list(await asyncio.gather(*coroutines))


async def run_all(
    providers: Sequence[Provider],
    items: Sequence[Item],
    repeats: int,
    concurrency: int,
    progress: Progress | None = None,
) -> dict[str, list[Judgment]]:
    """Run all providers in parallel; return judgments keyed by provider."""
    results = await asyncio.gather(
        *(
            run_provider(provider, items, repeats, concurrency, progress)
            for provider in providers
        )
    )
    return {
        provider.name: judgments
        for provider, judgments in zip(providers, results, strict=True)
    }


def save_judgments(path: Path, judgments: dict[str, list[Judgment]]) -> None:
    """Append every judgment as one JSON line for later re-analysis."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for batch in judgments.values():
            for judgment in batch:
                handle.write(json.dumps(judgment.model_dump()) + "\n")


def load_judgments(path: Path) -> dict[str, list[Judgment]]:
    """Inverse of :func:`save_judgments`."""
    grouped: dict[str, list[Judgment]] = {}
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                judgment = Judgment.model_validate_json(line)
                grouped.setdefault(judgment.provider, []).append(judgment)
    return grouped
