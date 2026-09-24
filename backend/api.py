"""REST API (Phase 4): session/diagram/transcript persistence, plus a
one-shot POST /api/process for text -> diagram extraction outside the live
WebSocket loop (used for testing, or a non-live "paste and extract" flow).
"""
import json
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sqlmodel import select

from backend.db import (
    Diagram,
    LectureSession,
    TranscriptChunk,
    create_session as db_create_session,
    get_session_factory,
)
from backend.services.diagram import GeminiParseError, ModelNotFoundError, extract_flowchart

log = logging.getLogger("api")

router = APIRouter(prefix="/api")


def _session_out(s: LectureSession) -> dict:
    return {"id": s.id, "created_at": s.created_at.isoformat(), "title": s.title}


def _diagram_out(d: Diagram) -> dict:
    return {
        "id": d.id,
        "session_id": d.session_id,
        "created_at": d.created_at.isoformat(),
        "graph": json.loads(d.graph_json),
        "source_text": d.source_text,
    }


def _chunk_out(c: TranscriptChunk) -> dict:
    return {"id": c.id, "ts": c.ts.isoformat(), "text": c.text, "source": c.source}


class CreateSessionBody(BaseModel):
    title: Optional[str] = None


class ProcessBody(BaseModel):
    text: str = Field(min_length=1, max_length=20_000)


@router.post("/sessions")
async def create_session(body: CreateSessionBody):
    s = await db_create_session(title=body.title)
    return _session_out(s)


@router.get("/sessions")
async def list_sessions():
    factory = get_session_factory()
    async with factory() as db:
        result = await db.exec(select(LectureSession).order_by(LectureSession.created_at.desc()))
        return [_session_out(s) for s in result.all()]


@router.get("/sessions/{session_id}")
async def get_session(session_id: str):
    factory = get_session_factory()
    async with factory() as db:
        s = await db.get(LectureSession, session_id)
        if not s:
            raise HTTPException(404, "session not found")
        diagrams = (await db.exec(
            select(Diagram).where(Diagram.session_id == session_id).order_by(Diagram.created_at)
        )).all()
        chunks = (await db.exec(
            select(TranscriptChunk).where(TranscriptChunk.session_id == session_id).order_by(TranscriptChunk.ts)
        )).all()
        out = _session_out(s)
        out["diagrams"] = [_diagram_out(d) for d in diagrams]
        out["transcript"] = [_chunk_out(c) for c in chunks]
        return out


@router.get("/diagrams/{diagram_id}")
async def get_diagram(diagram_id: str):
    factory = get_session_factory()
    async with factory() as db:
        d = await db.get(Diagram, diagram_id)
        if not d:
            raise HTTPException(404, "diagram not found")
        return _diagram_out(d)


@router.delete("/diagrams/{diagram_id}")
async def delete_diagram(diagram_id: str):
    factory = get_session_factory()
    async with factory() as db:
        d = await db.get(Diagram, diagram_id)
        if not d:
            raise HTTPException(404, "diagram not found")
        await db.delete(d)
        await db.commit()
        return {"deleted": diagram_id}


@router.post("/process")
async def process_text(body: ProcessBody):
    """Immediate, non-live extraction: text -> diagram, persisted under its own
    ad-hoc session so it fits the same schema as live-generated diagrams."""
    s = await db_create_session(title="API: /api/process")
    try:
        graph = await extract_flowchart(body.text)
    except ModelNotFoundError as e:
        raise HTTPException(500, str(e))
    except GeminiParseError as e:
        raise HTTPException(502, f"Gemini returned invalid flowchart JSON: {e}")

    graph_json = json.dumps(graph)
    factory = get_session_factory()
    async with factory() as db:
        d = Diagram(session_id=s.id, graph_json=graph_json, source_text=body.text)
        db.add(d)
        await db.commit()
        await db.refresh(d)

    return {"session_id": s.id, "diagram": _diagram_out(d)}
