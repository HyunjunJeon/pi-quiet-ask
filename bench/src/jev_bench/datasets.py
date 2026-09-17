"""Load benchmark items from JSONL files under ``bench/data``."""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path

from jev_bench.schema import Item, Task

DATA_DIR = Path(__file__).resolve().parents[2] / "data"


def iter_items(task: Task, data_dir: Path = DATA_DIR) -> Iterator[Item]:
    """Yield validated items for ``task`` from ``<data_dir>/<task>.jsonl``.

    Raises:
        FileNotFoundError: The dataset file does not exist.
        pydantic.ValidationError: A line does not match :class:`Item`.
    """
    path = data_dir / f"{task.value}.jsonl"
    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            payload = json.loads(line)
            payload.setdefault("task", task.value)
            item = Item.model_validate(payload)
            if item.gold_choice not in item.criteria:
                msg = (
                    f"{path}:{line_number}: gold_choice "
                    f"{item.gold_choice!r} not in criteria"
                )
                raise ValueError(msg)
            yield item


def load_items(task: Task, data_dir: Path = DATA_DIR) -> list[Item]:
    """Return all items for ``task`` as a list."""
    return list(iter_items(task, data_dir))
