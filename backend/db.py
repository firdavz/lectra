"""SQLite persistence (Phase 4): sessions, transcript chunks, diagrams.

Async only (aiosqlite driver via SQLAlchemy's async engine) -- consistent with
the rest of this codebase's "no asyncio.to_thread" rule. One shared engine +
sessionmaker per process; each call opens/closes its own AsyncSession so the
live WS loop and the REST endpoints in backend/api.py can both use it safely.
"""
import datetime
import os
import uuid
from typing import Optional

from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine
from sqlalchemy.orm import sessionmaker
from sqlmodel import Field, SQLModel
from sqlmodel.ext.asyncio.session import AsyncSession  # SQLModel's session -- adds .exec(), plain SQLAlchemy's AsyncSession doesn't have it

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite+aiosqlite:///./lecture.db")


def _new_id() -> str:
    return str(uuid.uuid4())


def _utcnow() -> datetime.datetime:
    return datetime.datetime.utcnow()


class LectureSession(SQLModel, table=True):
    __tablename__ = "sessions"
    id: str = Field(default_factory=_new_id, primary_key=True)
    created_at: datetime.datetime = Field(default_factory=_utcnow)
    title: Optional[str] = None


class Diagram(SQLModel, table=True):
    __tablename__ = "diagrams"
    id: str = Field(default_factory=_new_id, primary_key=True)
    session_id: str = Field(foreign_key="sessions.id", index=True)
    created_at: datetime.datetime = Field(default_factory=_utcnow)
    graph_json: str  # json.dumps({"nodes": [...], "edges": [...]})
    source_text: str  # mandatory: the exact buffer excerpt sent to Gemini for this diagram


class TranscriptChunk(SQLModel, table=True):
    __tablename__ = "transcript_chunks"
    id: str = Field(default_factory=_new_id, primary_key=True)
    session_id: str = Field(foreign_key="sessions.id", index=True)
    ts: datetime.datetime = Field(default_factory=_utcnow)
    text: str
    source: str  # "stt" | "manual"


_engine: Optional[AsyncEngine] = None
_session_factory = None


def _ensure_engine():
    global _engine, _session_factory
    if _engine is None:
        _engine = create_async_engine(DATABASE_URL, echo=False)
        _session_factory = sessionmaker(_engine, class_=AsyncSession, expire_on_commit=False)


def get_session_factory():
    _ensure_engine()
    return _session_factory


async def init_db():
    """Create tables if they don't exist yet. Safe to call every startup."""
    _ensure_engine()
    async with _engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)


async def create_session(title: Optional[str] = None) -> LectureSession:
    factory = get_session_factory()
    async with factory() as db:
        s = LectureSession(title=title)
        db.add(s)
        await db.commit()
        await db.refresh(s)
        return s


async def add_transcript_chunk(session_id: str, text: str, source: str) -> TranscriptChunk:
    factory = get_session_factory()
    async with factory() as db:
        c = TranscriptChunk(session_id=session_id, text=text, source=source)
        db.add(c)
        await db.commit()
        await db.refresh(c)
        return c


async def add_diagram(session_id: str, graph_json: str, source_text: str) -> Diagram:
    factory = get_session_factory()
    async with factory() as db:
        d = Diagram(session_id=session_id, graph_json=graph_json, source_text=source_text)
        db.add(d)
        await db.commit()
        await db.refresh(d)
        return d
