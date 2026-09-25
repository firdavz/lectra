"""The growing lecture map: a list of topics (subtopic groups), each a small
flowchart that only ever gains boxes and arrows -- nothing already on screen is
redrawn or dropped. Pure data logic, no I/O, so the merge rules can be tested
without Gemini or a WebSocket.

A topic is a plain dict, the same shape that goes to the browser:
    {"id": "t1", "title": "Baby is born",
     "nodes": [{"id": "t1n1", "label": "Baby elephant", "emoji": "🐘"}],
     "edges": [{"from": "t1n1", "to": "t1n2", "label": "falls to"}]}
"""
import re
from typing import Optional

from pydantic import BaseModel, Field, field_validator

MAX_NODES_PER_TOPIC = 10
MAX_TOPIC_SECONDS = 5 * 60  # a topic running longer than this is continued in a new group
MAX_LABEL_CHARS = 60


class MapNode(BaseModel):
    id: str
    label: str
    emoji: str = ""

    @field_validator("id", mode="before")
    @classmethod
    def _coerce_id(cls, v):
        return str(v)  # Gemini sometimes emits a bare number for an id


class MapEdge(BaseModel):
    from_: str = Field(alias="from")  # "from" is a Python keyword
    to: str
    label: str = ""

    model_config = {"populate_by_name": True}

    @field_validator("from_", "to", mode="before")
    @classmethod
    def _coerce_ids(cls, v):
        return str(v)


class MapGraph(BaseModel):
    nodes: list[MapNode] = []
    edges: list[MapEdge] = []


class MapUpdate(BaseModel):
    """One Gemini answer: boxes for the current topic, and optionally a new topic."""
    add: MapGraph = MapGraph()
    new_topic_title: str = ""
    new_topic: MapGraph = MapGraph()


class Topic(BaseModel):
    id: str
    title: str
    nodes: list[MapNode] = Field(default=[], max_length=100)
    edges: list[MapEdge] = Field(default=[], max_length=200)


def is_full(topic: dict, age_seconds: float) -> bool:
    return len(topic["nodes"]) >= MAX_NODES_PER_TOPIC or age_seconds >= MAX_TOPIC_SECONDS


def apply_update(topics: list[dict], update: MapUpdate, current_full: bool = False) -> list[str]:
    """Merge one Gemini update into `topics` in place. Returns the ids of the boxes it added.

    Boxes in "add" go to the current topic -- unless there is none yet, or it's
    full, in which case they start the next topic instead of being lost.
    """
    added: list[str] = []
    current: Optional[dict] = topics[-1] if topics else None
    # The prompt lists topics as "1. Title"; Gemini sometimes copies the number.
    title = _clean_label(re.sub(r"^\s*\d+\s*[.):-]\s*", "", update.new_topic_title))
    leftover = None
    if current is not None and not current_full:
        added += _merge(current, update.add)
    elif update.add.nodes:
        leftover = update.add

    if update.new_topic.nodes or leftover:
        if not title:
            title = _continued(current["title"]) if leftover and current else f"Topic {len(topics) + 1}"
        topic = {"id": f"t{len(topics) + 1}", "title": title, "nodes": [], "edges": []}
        topics.append(topic)
        if leftover:
            added += _merge(topic, leftover)
        added += _merge(topic, update.new_topic)
    return added


def restore_topics(raw) -> list[dict]:
    """Validate a map the browser sends back after a reconnect (see "resume")."""
    if not isinstance(raw, list) or len(raw) > 50:
        raise ValueError("topics must be a list of at most 50 topics")
    return [Topic.model_validate(t).model_dump(by_alias=True) for t in raw]


def _merge(topic: dict, graph: MapGraph) -> list[str]:
    """Add Gemini's boxes/arrows to one topic, giving new boxes stable map ids.

    Gemini's own ids are only meaningful inside one answer; arrows may also point
    at boxes already in this topic by their map id. A box whose label matches an
    existing one is reused instead of duplicated, and arrows to unknown boxes,
    self-loops and repeats are dropped rather than failing the whole update.
    """
    by_label = {_norm(n["label"]): n["id"] for n in topic["nodes"]}
    known = {n["id"] for n in topic["nodes"]}
    ids: dict[str, str] = {}  # Gemini's id -> map id
    added = []
    for n in graph.nodes:
        label = _clean_label(n.label)
        if not label:
            continue
        key = _norm(label)
        if key in by_label:
            ids[n.id] = by_label[key]
            continue
        map_id = f"{topic['id']}n{len(topic['nodes']) + 1}"
        topic["nodes"].append({"id": map_id, "label": label, "emoji": _clean_emoji(n.emoji)})
        ids[n.id] = by_label[key] = map_id
        known.add(map_id)
        added.append(map_id)

    pairs = {(e["from"], e["to"]) for e in topic["edges"]}
    for e in graph.edges:
        a = ids.get(e.from_) or (e.from_ if e.from_ in known else None)
        b = ids.get(e.to) or (e.to if e.to in known else None)
        if not a or not b or a == b or (a, b) in pairs:
            continue
        topic["edges"].append({"from": a, "to": b, "label": _clean_label(e.label)})
        pairs.add((a, b))
    return added


def _continued(title: str) -> str:
    """"Skin care" -> "Skin care (2)" -> "Skin care (3)"."""
    m = re.fullmatch(r"(.*) \((\d+)\)", title)
    return f"{m.group(1)} ({int(m.group(2)) + 1})" if m else f"{title} (2)"


def _clean_label(text: str) -> str:
    return " ".join((text or "").split())[:MAX_LABEL_CHARS]


def _clean_emoji(text: str) -> str:
    # Only a real emoji: Gemini occasionally puts a word here instead.
    text = (text or "").strip()
    if not text or len(text) > 8 or any(c.isalnum() for c in text):
        return ""
    return text


def _norm(label: str) -> str:
    return re.sub(r"[^\w ]", "", label.lower()).strip() or label
