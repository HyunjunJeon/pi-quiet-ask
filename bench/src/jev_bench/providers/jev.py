"""TypeSafe Jev provider.

Jev is a System One model: it returns a probability distribution over the
options we supply plus a yes-probability, in one parallel evaluation. We
send the Choice and the Noul together, as the TypeSafe docs recommend.
"""

from __future__ import annotations

import time

from typesafe_sdk import (
    AsyncTypeSafeClient,
    Choice,
    Noul,
    RetryPolicy,
    TypeSafeError,
)

from jev_bench.schema import Item, Judgment, normalise_probabilities

# Published launch pricing: $0.042 per million input tokens, output free.
JEV_USD_PER_INPUT_TOKEN = 0.042 / 1_000_000


class JevProvider:
    """Judge items with ``POST /v1/systemone``."""

    def __init__(
        self,
        model: str = "jev-latest",
        api_key: str | None = None,
        max_retries: int = 2,
    ) -> None:
        """Create a client; ``api_key`` falls back to ``TYPESAFE_API_KEY``."""
        self.name = model
        self._client = AsyncTypeSafeClient(
            api_key=api_key,
            model=model,
            retry=RetryPolicy(max_retries=max_retries),
        )

    async def judge(self, item: Item, repeat: int) -> Judgment:
        """Evaluate the item's Choice and Noul in a single request."""
        questions: dict[str, Choice | Noul] = {
            "choice": Choice(
                instructions=item.choice_instructions,
                criteria=item.criteria,
            ),
            "noul": Noul(instructions=item.noul_instructions),
        }
        started = time.perf_counter()
        try:
            response = await self._client.system_one(item.state, questions)
        except TypeSafeError as error:
            return Judgment(
                provider=self.name,
                item_id=item.id,
                repeat=repeat,
                choice=None,
                noul=None,
                latency_ms=(time.perf_counter() - started) * 1000,
                cost_usd=0.0,
                schema_ok=False,
                error=f"{type(error).__name__}: {error}",
            )
        latency_ms = (time.perf_counter() - started) * 1000

        choice = response.choices["choice"]
        noul = response.nouls["noul"]
        options = list(item.criteria)
        input_tokens = response.usage.input_tokens or 0
        return Judgment(
            provider=self.name,
            item_id=item.id,
            repeat=repeat,
            choice=choice.choice,
            probabilities=normalise_probabilities(
                dict(choice.probabilities), options
            ),
            noul=noul.noul,
            native_confidence=choice.confidence,
            latency_ms=latency_ms,
            cost_usd=input_tokens * JEV_USD_PER_INPUT_TOKEN,
            input_tokens=input_tokens,
            output_tokens=response.usage.output_tokens,
            # Jev is constrained to the supplied options by construction.
            schema_ok=choice.choice in item.criteria,
        )

    async def aclose(self) -> None:
        """Close the underlying HTTP client."""
        await self._client.aclose()
