"""LLM: grow the lecture map (backend/services/topics.py) with each new stretch of speech.

Uses the async `google-genai` client (NOT the deprecated `google-generativeai`
package, and NOT asyncio.to_thread/run_in_executor -- see backend/main.py's
top-of-file comment for why threaded network calls hang on this machine).
"""
import os
import json
import logging

from pydantic import ValidationError
from google import genai
from google.genai import types

from backend.services.topics import MapUpdate

log = logging.getLogger("diagram")

GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite")
MAX_SPEECH_CHARS = 6000


class GeminiParseError(RuntimeError):
    """Gemini returned something that isn't valid strict-schema map-update JSON.

    Distinct from network/model errors so the caller can send a narrower
    'gemini_parse' error stage to the browser and keep the current map.
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

SYSTEM = """You turn a live lecture into simple diagrams for students who are still
learning English. The lecture map is split into topics; each topic is a small
flowchart of boxes joined by arrows. The transcript is live speech-to-text:
expect filler words (um, uh, like), false starts and small mis-hearings.

You get the MAP SO FAR, the part of the lecture it ALREADY COVERS (context
only), and the NEW SPEECH. Add what the NEW SPEECH explains. Never repeat,
rename or rewrite anything already on the map.

Language rules (most important):
1. A box is a thing or an idea: 1 to 4 simple, everyday English words. No
   idioms, jokes, slang or rare words.
   Good: "Mud", "Wrinkled skin", "Baby elephant", "Big body".
   Bad: "Acts like a sponge", "High volume to surface area".
2. An arrow is one short, common verb: makes, has, needs, protects, holds,
   keeps, causes, becomes, helps, eats, lives in, is part of.
3. Read every arrow as a sentence: [from box] [arrow] [to box]. It must be a
   correct, simple sentence that the speaker said or clearly meant.
   Good: Mud -> protects -> Skin. Wrinkled skin -> holds -> Water.
         Water -> cools -> Elephant.
   Bad:  Thick skin -> creates -> Acts like a sponge (not a sentence).
         No sweat glands -> requires -> Cooling (the speaker did not say this).
4. Never invent causes or facts. Arrow direction matters.
5. emoji: one emoji only when it clearly pictures a concrete thing (an animal,
   object, food, weather, body part). Leave it "" for most boxes and for every
   abstract idea.

Topic rules:
6. Boxes about the current subject go in "add". Arrows in "add" may connect to
   boxes already in the CURRENT TOPIC, using their ids.
7. When the speaker moves to a different subject, or the CURRENT TOPIC is
   marked FULL, start a new topic: "new_topic_title" (1 to 4 simple words) and
   its boxes and arrows in "new_topic". Arrows in "new_topic" only connect
   boxes inside "new_topic".
8. If the NEW SPEECH is only greetings, logistics or small talk, or adds
   nothing new, return everything empty.
9. Ids for new boxes: short strings like "a", "b", "c", unique in your answer.
10. A topic has at most about 10 boxes. Add at most 5 new boxes per answer:
    only the most important ideas.
"""

_GRAPH_SCHEMA = {
    "type": "object",
    "properties": {
        "nodes": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "label": {"type": "string"},
                    "emoji": {"type": "string"},
                },
                "required": ["id", "label", "emoji"],
            },
        },
        "edges": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "from": {"type": "string"},
                    "to": {"type": "string"},
                    "label": {"type": "string"},
                },
                "required": ["from", "to", "label"],
            },
        },
    },
    "required": ["nodes", "edges"],
}

# Enforced by the API, not just described in the prompt: with the shape only
# described in text, flash-lite was seen dropping every edge's "to". What a
# schema can't check (arrows pointing at boxes that exist) is handled when the
# update is merged into the map.
UPDATE_SCHEMA = {
    "type": "object",
    "properties": {
        "add": _GRAPH_SCHEMA,
        "new_topic_title": {"type": "string"},
        "new_topic": _GRAPH_SCHEMA,
    },
    "required": ["add", "new_topic_title", "new_topic"],
}

_CONFIG = types.GenerateContentConfig(
    system_instruction=SYSTEM,
    response_mime_type="application/json",
    response_json_schema=UPDATE_SCHEMA,
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


def _describe_map(topics: list[dict], current_full: bool) -> str:
    if not topics:
        return "MAP SO FAR: empty (this is the start of the lecture)"
    lines = []
    if len(topics) > 1:
        earlier = "; ".join(f"{i + 1}. {t['title']}" for i, t in enumerate(topics[:-1]))
        lines.append(f"EARLIER TOPICS (finished): {earlier}")
    current = topics[-1]
    full = " -- FULL: put anything new in a new topic" if current_full else ""
    lines.append(f"CURRENT TOPIC: {len(topics)}. {current['title']}{full}")
    lines.append("Boxes:")
    lines += [f"- {n['id']}: {n['label']}" for n in current["nodes"]]
    lines.append("Arrows:")
    lines += [f"- {e['from']} -> {e['label']} -> {e['to']}" for e in current["edges"]] or ["- (none)"]
    return "\n".join(lines)


async def extract_update(topics: list[dict], covered: str, speech: str, current_full: bool) -> MapUpdate:
    """Async Gemini call -> what to add to the map for `speech`. Never blocks the event loop.

    Raises ModelNotFoundError for a bad GEMINI_MODEL, GeminiParseError when the
    response isn't valid strict-schema JSON (caller logs/reports and keeps the
    current map), or lets any other exception (network, auth, ...) propagate.
    """
    prompt = (
        f"{_describe_map(topics, current_full)}\n\n"
        f"ALREADY COVERS (context only): \"...{covered[-400:]}\"\n\n"
        f"NEW SPEECH: \"{speech[-MAX_SPEECH_CHARS:]}\""
    )
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
        update = MapUpdate.model_validate(json.loads(raw_text))
    except (json.JSONDecodeError, ValidationError) as e:
        log.warning("[TRACE] parse FAILED: %s | raw=%r", e, raw_text[:500])
        raise GeminiParseError(f"invalid map update JSON from Gemini: {e}") from e
    log.info("[TRACE] parse OK: +%d boxes, new topic %r (+%d boxes)",
             len(update.add.nodes), update.new_topic_title, len(update.new_topic.nodes))
    return update
