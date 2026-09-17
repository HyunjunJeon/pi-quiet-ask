"""Command line entry point: ``uv run jev-bench --task tool_gate``."""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from rich.console import Console
from rich.progress import Progress

from jev_bench.datasets import load_items
from jev_bench.metrics import compute_metrics
from jev_bench.providers import JevProvider, OpenRouterProvider, Provider
from jev_bench.report import markdown_report, print_table
from jev_bench.runner import run_all, save_judgments
from jev_bench.schema import Item, Judgment, Task

RESULTS_DIR = Path(__file__).resolve().parents[2] / "results"

DEFAULT_LLMS = (
    "openai/gpt-5.6-luna",
    "openai/gpt-5.6-terra",
    "anthropic/claude-haiku-4.5",
    "google/gemini-3.8-flash",
)


def _build_providers(args: argparse.Namespace) -> list[Provider]:
    providers: list[Provider] = []
    for jev_model in args.jev:
        providers.append(JevProvider(model=jev_model))
    if args.llm:
        key = os.environ.get("OPENROUTER_API_KEY")
        if not key:
            sys.exit("OPENROUTER_API_KEY is required for --llm")
        providers.extend(
            OpenRouterProvider(
                model=model, api_key=key, temperature=args.temperature
            )
            for model in args.llm
        )
    return providers


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--task",
        action="append",
        choices=[t.value for t in Task],
        help="Task(s) to run; default: all",
    )
    parser.add_argument(
        "--jev",
        action="append",
        default=None,
        help="Jev model name(s); default: jev-latest",
    )
    parser.add_argument(
        "--llm",
        action="append",
        default=None,
        help="OpenRouter model id(s); default: a small comparison set",
    )
    parser.add_argument("--no-llm", action="store_true")
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument(
        "--temperature",
        type=float,
        default=0.0,
        help="LLM sampling temperature (Jev has none)",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=RESULTS_DIR,
        help="Directory for <task>.jsonl and REPORT.md",
    )
    return parser.parse_args(argv)


async def _run_task(
    providers: list[Provider],
    items: list[Item],
    args: argparse.Namespace,
    console: Console,
) -> dict[str, list[Judgment]]:
    """Run one task and close providers inside the same event loop.

    httpx transports must be closed on the loop that created them, so the
    run and the cleanup share a single ``asyncio.run``.
    """
    try:
        with Progress(console=console, transient=True) as progress:
            return await run_all(
                providers, items, args.repeats, args.concurrency, progress
            )
    finally:
        for provider in providers:
            await provider.aclose()


def main(argv: list[str] | None = None) -> None:
    """Run the benchmark and write results."""
    # .env lives at the repository root, one level above bench/.
    load_dotenv(Path(__file__).resolve().parents[3] / ".env")
    args = _parse_args(argv)
    if args.jev is None:
        args.jev = ["jev-latest"]
    if args.no_llm:
        args.llm = []
    elif args.llm is None:
        args.llm = list(DEFAULT_LLMS)
    tasks = [Task(t) for t in (args.task or [t.value for t in Task])]

    console = Console()
    report_sections: list[str] = []
    for task in tasks:
        items = load_items(task)
        providers = _build_providers(args)
        console.rule(f"{task}: {len(items)} items x {args.repeats}")
        judgments = asyncio.run(_run_task(providers, items, args, console))

        save_judgments(args.out / f"{task.value}.jsonl", judgments)
        metrics = [
            compute_metrics(name, items, batch)
            for name, batch in judgments.items()
        ]
        print_table(task.value, metrics, console)
        report_sections.append(
            markdown_report(task.value, metrics, items, judgments)
        )

    report_path = args.out / "REPORT.md"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    header = (
        "# Jev vs chat LLMs on coding-agent decisions\n\n"
        f"repeats={args.repeats}, LLM temperature={args.temperature}, "
        "confidence = 1 - normalised entropy of option probabilities.\n"
        "sel@t = coverage/accuracy when auto-accepting answers with "
        "confidence >= t.\n\n"
    )
    report_path.write_text(header + "\n".join(report_sections))
    console.print(f"\nwrote {report_path}")


if __name__ == "__main__":
    main()
