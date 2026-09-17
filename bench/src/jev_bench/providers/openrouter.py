"""OpenRouter chat-LLM provider.

The LLM is asked for the same closed-set decision as Jev, as strict JSON:
``{"choice": ..., "probabilities": {...}, "noul": 0..1}``. This mirrors how
one would coerce a chat model into a structured decision in production,
which is exactly the mismatch TypeSafe's docs describe. Parse failures,
invented options and non-normalised distributions are all recorded as
schema violations rather than silently repaired away.
"""

from __future__ import annotations

import json
import time
from typing import Any

import httpx

from jev_bench.schema import Item, Judgment, normalise_probabilities

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

SYSTEM_PROMPT = """You are a decision function inside a coding agent.
You never write prose. You answer exactly one multiple-choice question and
one yes/no question about the given STATE, and reply with a single JSON
object and nothing else:

{"choice": "<one option id exactly as listed>",
 "probabilities": {"<option id>": <0..1>, ...},
 "noul": <0..1>}

"probabilities" has one entry per option and sums to 1.
"noul" is the probability that the yes/no answer is yes.

Rules:
- Use only the option ids given. Do not invent options.
- Probabilities must cover every option and sum to 1.
- "noul" near 1 means yes, near 0 means no, 0.5 means unsure.
- Output JSON only. No markdown fences, no explanation."""


def _user_prompt(item: Item) -> str:
    options = "\n".join(
        f'- "{key}": {desc or "(no description)"}'
        for key, desc in item.criteria.items()
    )
    state = (
        item.state
        if isinstance(item.state, str)
        else json.dumps(item.state, ensure_ascii=False, indent=2)
    )
    return (
        f"STATE:\n{state}\n\n"
        f"MULTIPLE CHOICE: {item.choice_instructions}\n"
        f"OPTIONS:\n{options}\n\n"
        f"YES/NO: {item.noul_instructions}\n\n"
        "Reply with the JSON object only."
    )


def _extract_json(text: str) -> dict[str, Any]:
    """Parse the first JSON object in ``text``; tolerate code fences."""
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = stripped.strip("`")
        if stripped.startswith("json"):
            stripped = stripped[4:]
    start = stripped.find("{")
    end = stripped.rfind("}")
    if start == -1 or end == -1:
        msg = "no JSON object in response"
        raise ValueError(msg)
    payload = json.loads(stripped[start : end + 1])
    if not isinstance(payload, dict):
        msg = "JSON root is not an object"
        raise ValueError(msg)
    return payload


class OpenRouterProvider:
    """Judge items with an OpenRouter-hosted chat model."""

    def __init__(
        self,
        model: str,
        api_key: str,
        temperature: float | None = 0.0,
        timeout_s: float = 90.0,
    ) -> None:
        """Create a provider for ``model`` (e.g. ``openai/gpt-5.6-luna``)."""
        self.name = model
        self._temperature = temperature
        self._client = httpx.AsyncClient(
            timeout=timeout_s,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "HTTP-Referer": "https://github.com/HyunjunJeon/pi-quiet-ask",
                "X-Title": "jev-bench",
            },
        )

    async def judge(self, item: Item, repeat: int) -> Judgment:
        """Call the chat completion endpoint and parse the JSON decision."""
        body: dict[str, Any] = {
            "model": self.name,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": _user_prompt(item)},
            ],
            "response_format": {"type": "json_object"},
            # Ask OpenRouter to attach the billed cost to the response.
            "usage": {"include": True},
        }
        if self._temperature is not None:
            body["temperature"] = self._temperature

        started = time.perf_counter()
        try:
            response = await self._client.post(OPENROUTER_URL, json=body)
            response.raise_for_status()
            data = response.json()
        except (httpx.HTTPError, ValueError) as error:
            return self._failure(item, repeat, started, str(error))
        latency_ms = (time.perf_counter() - started) * 1000

        usage = data.get("usage") or {}
        cost = float(usage.get("cost") or 0.0)
        input_tokens = usage.get("prompt_tokens")
        output_tokens = usage.get("completion_tokens")

        try:
            content = data["choices"][0]["message"]["content"] or ""
            payload = _extract_json(content)
        except (KeyError, IndexError, ValueError, TypeError) as error:
            return self._failure(
                item,
                repeat,
                started,
                f"unparseable: {error}",
                cost=cost,
                latency_ms=latency_ms,
            )

        options = list(item.criteria)
        raw_probs = payload.get("probabilities")
        raw_choice = payload.get("choice")
        raw_noul = payload.get("noul")

        schema_ok = (
            isinstance(raw_probs, dict)
            and raw_choice in item.criteria
            and set(raw_probs) == set(options)
            and _is_number(raw_noul)
            and abs(sum(float(v) for v in raw_probs.values()) - 1.0) <= 0.05
        )

        probabilities = normalise_probabilities(
            raw_probs if isinstance(raw_probs, dict) else {}, options
        )
        # If the LLM named an option but gave no usable distribution,
        # fall back to a one-hot so accuracy can still be scored.
        if raw_choice in item.criteria and not any(probabilities.values()):
            probabilities = {
                option: float(option == raw_choice) for option in options
            }

        return Judgment(
            provider=self.name,
            item_id=item.id,
            repeat=repeat,
            choice=raw_choice if raw_choice in item.criteria else None,
            probabilities=probabilities,
            noul=_clamp(raw_noul),
            latency_ms=latency_ms,
            cost_usd=cost,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            schema_ok=bool(schema_ok),
            error=None if schema_ok else "schema violation",
        )

    def _failure(
        self,
        item: Item,
        repeat: int,
        started: float,
        error: str,
        cost: float = 0.0,
        latency_ms: float | None = None,
    ) -> Judgment:
        return Judgment(
            provider=self.name,
            item_id=item.id,
            repeat=repeat,
            choice=None,
            noul=None,
            latency_ms=latency_ms
            if latency_ms is not None
            else (time.perf_counter() - started) * 1000,
            cost_usd=cost,
            schema_ok=False,
            error=error,
        )

    async def aclose(self) -> None:
        """Close the HTTP client."""
        await self._client.aclose()


def _is_number(value: object) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool)


def _clamp(value: object) -> float | None:
    if not _is_number(value):
        return None
    return min(1.0, max(0.0, float(value)))  # type: ignore[arg-type]
