"""Provider protocol shared by Jev and LLM adapters."""

from __future__ import annotations

from typing import Protocol

from jev_bench.schema import Item, Judgment


class Provider(Protocol):
    """Anything that can judge a benchmark item."""

    name: str

    async def judge(self, item: Item, repeat: int) -> Judgment:
        """Return a normalised judgment for ``item``.

        Implementations must never raise for provider-side failures;
        they return a :class:`Judgment` with ``schema_ok=False`` and
        ``error`` set so the failure is counted, not hidden.
        """
        ...

    async def aclose(self) -> None:
        """Release network resources."""
        ...
