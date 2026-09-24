"""LLM: turn a transcript excerpt into flowchart nodes/edges (the "hard part" extractor).

Uses the async `google-genai` client (NOT the deprecated `google-generativeai`
package, and NOT asyncio.to_thread/run_in_executor -- see backend/main.py's
top-of-file comment for why threaded network calls hang on this machine).
"""
import os
import json
import logging
from typing import Optional

from pydantic import BaseModel, Field, ValidationError, field_validator
from google import genai
from google.genai import types

log = logging.getLogger("diagram")

GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.6-flash")


class Node(BaseModel):
    id: str
    label: str

    @field_validator("id", mode="before")
    @classmethod
    def _coerce_id_str(cls, v):
        # Gemini can emit a bare number for a numeric-looking id (e.g. 1 instead
        # of "1") despite the schema showing quoted examples. Coerce rather than
        # reject -- edges reference ids by value and need the same coercion.
        return str(v)


class Edge(BaseModel):
    from_: str = Field(alias="from")  # "from" is a Python keyword; alias matches Gemini's JSON key
    to: str
    label: Optional[str] = None

    model_config = {"populate_by_name": True}

    @field_validator("from_", "to", mode="before")
    @classmethod
    def _coerce_str(cls, v):
        return str(v)


class FlowchartGraph(BaseModel):
    nodes: list[Node] = []
    edges: list[Edge] = []

    @field_validator("edges")
    @classmethod
    def _edges_reference_known_nodes(cls, edges, info):
        node_ids = {n.id for n in info.data.get("nodes", [])}
        for e in edges:
            if e.from_ not in node_ids or e.to not in node_ids:
                raise ValueError(
                    f"edge {e.from_!r}->{e.to!r} references a node id not present in nodes"
                )
        return edges


class GeminiParseError(RuntimeError):
    """Gemini returned something that isn't valid strict-schema flowchart JSON.

    Distinct from network/model errors so the caller can send a narrower
    'gemini_parse' error stage to the browser and keep the previous diagram.
    """

_client = None  # lazily constructed -- lets the app boot and serve the frontend
# even before GEMINI_API_KEY is set, failing clearly only when extraction is
# actually attempted instead of crashing the whole server at import time.


def _get_client() -> genai.Client:
    global _client
    if _client is None:
        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            raise RuntimeError("GEMINI_API_KEY is not set (check .env)")
        _client = genai.Client(api_key=api_key)
    return _client

SYSTEM = """You read a running lecture transcript and extract the HARD, confusing
part as a small flowchart.

Rules:
1. If the transcript is filler talk with no real conceptual structure yet
   (greetings, "let's begin", small talk, silence, off-topic chatter), return
   exactly {"nodes": [], "edges": []} -- do not invent structure that isn't there.
2. Otherwise, prefer 4 to 10 nodes that cover the hard part being explained.
3. Keep every node and edge label under about 6 words.
4. Output ONLY raw JSON, no markdown code fences, no commentary before or
   after it, in exactly this shape:
   {"nodes": [{"id": "1", "label": "..."}], "edges": [{"from": "1", "to": "2", "label": "..."}]}
"""

_CONFIG = types.GenerateContentConfig(
    system_instruction=SYSTEM,
    response_mime_type="application/json",
)


class ModelNotFoundError(RuntimeError):
    """Raised when GEMINI_MODEL doesn't exist / isn't available to this key.

    Surfaced with the exact model string so it's a one-line fix in .env.
    """


def _strip_code_fence(text: str) -> str:
    """response_mime_type=application/json should already prevent markdown fences,
    but strip them defensively in case a model/SDK combo wraps output anyway."""
    text = text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else ""
        if text.endswith("```"):
            text = text[:-3]
        text = text.strip()
    return text


async def extract_flowchart(transcript_so_far: str) -> dict:
    """Async Gemini call -> {"nodes": [...], "edges": [...]}. Never blocks the event loop.

    Raises ModelNotFoundError for a bad GEMINI_MODEL, GeminiParseError when the
    response isn't valid strict-schema JSON (caller logs/reports and keeps the
    previous diagram), or lets any other exception (network, auth, ...) propagate.
    """
    prompt = transcript_so_far[-4000:]
    try:
        response = await _get_client().aio.models.generate_content(
            model=GEMINI_MODEL,
            contents=prompt,
            config=_CONFIG,
        )
    except Exception as e:
        msg = str(e).lower()
        if "not found" in msg or "404" in msg:
            raise ModelNotFoundError(
                f"Gemini model '{GEMINI_MODEL}' not found or unavailable for this API key. "
                f"Set GEMINI_MODEL in .env to a currently-supported model name."
            ) from e
        raise

    log.info("[TRACE] gemini responded: %r", (response.text or "")[:120])
    raw_text = _strip_code_fence(response.text or "")
    try:
        parsed = json.loads(raw_text)
        graph = FlowchartGraph.model_validate(parsed)
    except (json.JSONDecodeError, ValidationError) as e:
        log.warning("[TRACE] parse FAILED: %s | raw=%r", e, raw_text[:500])
        raise GeminiParseError(f"invalid flowchart JSON from Gemini: {e}") from e
    log.info("[TRACE] parse OK: %d nodes, %d edges", len(graph.nodes), len(graph.edges))

    return {
        "nodes": [n.model_dump() for n in graph.nodes],
        "edges": [e.model_dump(by_alias=True, exclude_none=True) for e in graph.edges],
    }
