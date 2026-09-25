"""FastAPI app: live mic audio in (relayed to ElevenLabs Scribe) or typed text in
-> live flowchart JSON out, over one WebSocket per browser tab.
"""
import asyncio
import difflib
import json
import logging
import os
import re
import time
from contextlib import asynccontextmanager

import pip_system_certs.wrapt_requests  # trust Windows cert store (fixes Avast SSL-scan MITM)
from pathlib import Path
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
import websockets as ws_lib

load_dotenv()

from backend import db
from backend.api import router as api_router
from backend.services.diagram import extract_update, ModelNotFoundError, GeminiParseError
from backend.services.topics import apply_update, is_full, restore_topics
from backend.services.transcribe import ScribeRealtimeClient, ScribeConnectionError

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("main")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.init_db()
    log.info("database ready (%s)", db.DATABASE_URL)
    yield


app = FastAPI(lifespan=lifespan)
app.include_router(api_router)

FRONTEND_DIR = Path(__file__).parent.parent / "frontend"
app.mount("/static", StaticFiles(directory=FRONTEND_DIR, html=True), name="static")

EXTRACTION_INTERVAL_SECONDS = int(os.getenv("EXTRACTION_INTERVAL_SECONDS", "20"))
MIN_EXTRACTION_GAP_SECONDS = int(os.getenv("MIN_EXTRACTION_GAP_SECONDS", "8"))
# Hard floor on Gemini calls, enforced server-side regardless of how fast the
# client sends "force" messages -- the frontend's own cooldown is a courtesy,
# not something this loop trusts.
MAX_BACKOFF_SKIPS = 6  # after a Gemini error, wait up to this many extra cycles
# before trying again, instead of hammering an API that's already saying no.
STOP_FLUSH_TIMEOUT_SECONDS = 3  # on Stop, how long to wait for Scribe to commit its last partial
GEMINI_TIMEOUT_SECONDS = 30  # a hung call must not stall the map for the rest of the lecture
MAX_UPDATE_CHARS = 600  # one map update covers at most about this much speech; a longer
# backlog (a pasted transcript) is split over several updates, a few seconds apart.

# Errors from Scribe that mean "stop trying, this session is dead" vs. transient.
_SCRIBE_FATAL_ERRORS = {"auth_error", "unaccepted_terms", "quota_exceeded"}


def split_edit(covered_text: str, edited: str) -> tuple[str, str]:
    """Split an edited transcript into (what the map already covers, what's new).

    The new part is everything after the last run of words that matches the
    covered text -- a pasted transcript, or speech the map hasn't reached yet --
    so small corrections inside the covered part don't get diagrammed twice.
    The new part keeps its line breaks (see speech_segments).
    """
    spans = [m.span() for m in re.finditer(r"\S+", edited)]
    words = [edited[a:b] for a, b in spans]
    blocks = difflib.SequenceMatcher(a=covered_text.split(), b=words, autojunk=False).get_matching_blocks()
    end = max((m.b + m.size for m in blocks if m.size), default=0)
    if end >= len(spans):
        return edited.strip(), ""
    cut = spans[end][0]
    return edited[:cut].strip(), edited[cut:].strip()


def speech_segments(text: str) -> list[str]:
    """Pasted text as segments for the map updates: a paragraph each (usually
    one subtopic, so updates line up with topics), or its sentences when a
    paragraph is longer than MAX_UPDATE_CHARS."""
    out = []
    for para in re.split(r"\n\s*\n", text.strip()):
        para = " ".join(para.split())
        if len(para) <= MAX_UPDATE_CHARS:
            out += [para] if para else []
        else:
            out += [s for s in re.split(r"(?<=[.!?])\s+", para) if s]
    return out

@app.get("/")
async def root():
    return RedirectResponse("/static/index.html")

@app.websocket("/ws/lecture")
async def lecture_ws(ws: WebSocket):
    await ws.accept()
    log.info("browser ws connected")
    # Sent once per connection (including reconnects) so the frontend's "next
    # diagram in Ns" countdown starts in sync with this connection's own
    # extraction_loop timer below, without hardcoding the interval client-side.
    await ws.send_json({"type": "config", "extraction_interval_seconds": EXTRACTION_INTERVAL_SECONDS})

    session_id: str | None = None
    try:
        session_row = await db.create_session()
        session_id = session_row.id
        log.info("persistence session created id=%s", session_id)
    except Exception:
        log.exception("failed to create a persistence session; this lecture's transcript/diagrams won't be saved")

    stt_chunks: list[str] = []  # committed Scribe segments, in order
    covered = 0  # stt_chunks[:covered] are already in the map
    seen_partial = ""  # start of segment `covered` an extraction already saw while it was a partial
    partial_text = ""  # Scribe's current not-yet-committed segment
    committed = asyncio.Event()  # set whenever Scribe commits a segment (used by the Stop flush)
    manual_text = ""  # latest text sent as a "manual_text" message
    used_manual = ""  # manual_text snapshot already in the map
    last_persisted_manual = ""  # last manual_text snapshot already written as a transcript_chunks row
    topics: list[dict] = []  # the growing lecture map, see backend/services/topics.py
    topic_started = 0.0  # monotonic time the current topic was opened
    stopping = False  # Stop pressed: extraction_loop runs one final pass, sends "stopped", and exits
    force_event = asyncio.Event()
    scribe = {"client": None, "task": None}  # mutable holder so closures can rebind

    async def safe_send(payload: dict):
        try:
            await ws.send_json(payload)
            log.info("[TRACE] sent to browser: type=%s size=%d bytes", payload.get("type"), len(json.dumps(payload)))
        except Exception:
            pass  # socket already closing; nothing to do

    async def persist_chunk(text: str, source: str):
        if not session_id or not text:
            return
        try:
            await db.add_transcript_chunk(session_id, text, source)
        except Exception:
            log.exception("failed to persist transcript chunk (source=%s)", source)

    async def persist_map(source_text: str):
        if not session_id:
            return
        try:
            await db.add_diagram(session_id, json.dumps({"topics": topics}), source_text)
        except Exception:
            log.exception("failed to persist diagram")

    def pending_speech() -> tuple[str, int, bool]:
        """Speech the map doesn't cover yet, as (text, committed segments used,
        whether Scribe's in-progress partial is included): committed segments
        past `covered`, then the partial (VAD only commits on a pause, and a long
        unbroken explanation can run 30s+ without one), minus the start of the
        first one an earlier extraction already saw while it was a partial.
        Whole segments up to about MAX_UPDATE_CHARS, at least one; the rest is
        left for the next update."""
        committed_left = len(stt_chunks) - covered
        segments = stt_chunks[covered:] + ([partial_text] if partial_text else [])
        if segments and seen_partial and segments[0].startswith(seen_partial):
            segments[0] = segments[0][len(seen_partial):]
        parts, size = [], 0
        for s in segments:
            if parts and size + len(s) > MAX_UPDATE_CHARS:
                break
            parts.append(s)
            size += len(s)
        used, with_partial = min(len(parts), committed_left), len(parts) > committed_left
        if manual_text and manual_text != used_manual:
            parts.append(manual_text)
        return " ".join(p.strip() for p in parts if p.strip()), used, with_partial

    async def add_committed_text(text: str):
        """A finished Scribe segment: into the extraction buffer, to the browser, and to the DB."""
        nonlocal partial_text
        partial_text = ""
        if not text:
            return
        stt_chunks.append(text)
        log.info("[TRACE] text entered buffer via stt (len=%d chars): %r", len(text), text[:80])
        await safe_send({"type": "transcript_chunk", "text": text, "source": "scribe"})
        await persist_chunk(text, "stt")

    async def scribe_recv_loop(client: ScribeRealtimeClient):
        nonlocal partial_text
        try:
            async for event in client.events():
                mtype = event.get("message_type")
                if mtype in ("committed_transcript", "final_transcript"):
                    await add_committed_text((event.get("text") or "").strip())
                    committed.set()
                elif mtype == "partial_transcript":
                    partial_text = (event.get("text") or "").strip()
                    await safe_send({"type": "partial_transcript", "text": event.get("text", "")})
                elif mtype in ("warning",):
                    log.warning("scribe warning: %s", event.get("warning"))
                elif mtype and ("error" in mtype or mtype in _SCRIBE_FATAL_ERRORS):
                    detail = event.get("error", mtype)
                    log.warning("scribe error event: %s", detail)
                    await safe_send({"type": "stt_status", "state": "error", "detail": str(detail)})
        except ws_lib.exceptions.ConnectionClosed:
            pass
        except Exception:
            log.exception("scribe recv loop crashed")
        finally:
            scribe["client"] = None
            scribe["task"] = None
            log.info("scribe disconnected")
            await safe_send({"type": "stt_status", "state": "disconnected"})

    async def start_stt():
        if scribe["client"] is not None:
            return  # already running
        client = ScribeRealtimeClient()
        try:
            await client.connect()
        except ScribeConnectionError as e:
            log.warning("scribe connect failed: %s", e)
            await safe_send({"type": "stt_status", "state": "error", "detail": str(e)})
            return
        scribe["client"] = client
        log.info("scribe connected id=%s", client.session_id)
        await safe_send({"type": "stt_status", "state": "connected"})
        scribe["task"] = asyncio.create_task(scribe_recv_loop(client))

    async def stop_stt(flush: bool = False):
        task = scribe["task"]
        client = scribe["client"]
        unflushed = ""
        if flush and client and partial_text:
            # Closing now would drop the speech since Scribe's last VAD commit.
            # Ask it to commit and wait for that committed_transcript first.
            committed.clear()
            try:
                await client.commit()
                await asyncio.wait_for(committed.wait(), timeout=STOP_FLUSH_TIMEOUT_SECONDS)
            except Exception as e:
                log.warning("scribe flush on stop failed (%r); keeping its last partial instead", e)
                unflushed = partial_text
        scribe["task"] = None
        scribe["client"] = None
        if task:
            task.cancel()
        if client:
            await client.close()
        if unflushed:
            await add_committed_text(unflushed)

    async def handle_audio_chunk(data: bytes):
        # Logged at INFO (not DEBUG) deliberately: this line landing in the log
        # *during* a Gemini extraction call is exactly the Phase-1 proof that
        # the async Gemini client isn't blocking the event loop anymore.
        log.info("audio chunk received: %d bytes @ %.3f", len(data), time.monotonic())
        client = scribe["client"]
        if client:
            try:
                await client.send_audio_chunk(data)
            except Exception as e:
                log.warning("failed forwarding audio to scribe: %s", e)

    async def handle_text_message(raw: str):
        nonlocal manual_text, stopping, covered, seen_partial, topic_started
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            return
        mtype = msg.get("type")
        if mtype == "manual_text":
            manual_text = msg.get("text", "")
            log.info("[TRACE] text entered buffer via manual box (len=%d chars)", len(manual_text))
        elif mtype == "transcript_edit":
            # The transcript was corrected, or a ready transcript was pasted in.
            # What the map already covers stays covered (its boxes don't change);
            # anything new is queued as speech, a paragraph per segment, so a long
            # paste is diagrammed over several updates.
            corrected = (msg.get("text") or "").strip()
            done, new = split_edit(" ".join(stt_chunks[:covered]), corrected)
            stt_chunks[:] = ([done] if done else []) + speech_segments(new)
            covered = 1 if done else 0
            seen_partial = ""
            log.info("transcript edited (len=%d chars, %d new)", len(corrected), len(new))
            await persist_chunk(corrected, "correction")
        elif mtype == "resume":
            # Reconnect, or Start again after Stop: carry on the map the browser
            # already shows instead of starting an empty one.
            if not topics:
                try:
                    topics[:] = restore_topics(msg.get("topics"))
                    topic_started = time.monotonic()
                    log.info("map resumed from browser: %d topics", len(topics))
                except ValueError as e:
                    log.warning("ignoring invalid resume message: %s", e)
        elif mtype == "force":
            force_event.set()
        elif mtype == "stt_start":
            await start_stt()
        elif mtype == "stt_stop":
            # Stop: flush Scribe's last partial, then wake extraction_loop for one
            # final pass over it. The browser keeps the socket open until that pass
            # sends "stopped", so the end of the lecture still gets diagrammed.
            await stop_stt(flush=True)
            stopping = True
            force_event.set()

    async def receive_loop():
        while True:
            message = await ws.receive()
            if message["type"] == "websocket.disconnect":
                raise WebSocketDisconnect(message.get("code", 1000))
            if message.get("bytes") is not None:
                await handle_audio_chunk(message["bytes"])
            elif message.get("text") is not None:
                await handle_text_message(message["text"])

    async def extract_and_send(text: str, used: int, with_partial: bool) -> bool:
        """One Gemini call that grows the map with `text` (the result of
        pending_speech(), called right before with no await in between); sends
        the updated map (or "empty"/"error") to the browser and persists it.
        Returns False on a Gemini error so the caller can back off."""
        nonlocal last_persisted_manual, covered, seen_partial, used_manual, topic_started
        # What `text` was built from; marked as covered only once Gemini succeeds.
        start_covered, partial_snapshot, manual_snapshot = covered, partial_text, manual_text
        start = time.monotonic()
        current_full = bool(topics) and is_full(topics[-1], start - topic_started)
        if manual_text and manual_text != last_persisted_manual:
            # One transcript_chunks row per distinct manual_text snapshot that
            # actually fed an extraction -- not per keystroke.
            await persist_chunk(manual_text, "manual")
            last_persisted_manual = manual_text
        log.info("[TRACE] extraction started (len=%d chars): %r", len(text), text[:80])
        try:
            update = await asyncio.wait_for(
                extract_update(topics, " ".join(stt_chunks[:covered]), text, current_full),
                timeout=GEMINI_TIMEOUT_SECONDS,
            )
        except asyncio.TimeoutError:
            log.error("gemini didn't answer within %ss", GEMINI_TIMEOUT_SECONDS)
            await safe_send({"type": "error", "stage": "gemini", "detail": f"Gemini didn't answer within {GEMINI_TIMEOUT_SECONDS}s"})
            return False
        except ModelNotFoundError as e:
            log.error("gemini model error: %s", e)
            await safe_send({"type": "error", "stage": "gemini", "detail": str(e)})
            return False
        except GeminiParseError as e:
            # Invalid/unparseable JSON from Gemini: narrower stage so the
            # frontend can distinguish it from a network/auth/model error.
            # Previous diagram on screen is left untouched -- we simply
            # don't send a "diagram" message this cycle.
            log.error("gemini parse error: %s", e)
            await safe_send({"type": "error", "stage": "gemini_parse", "detail": str(e)[:300]})
            return False
        except Exception as e:
            log.error("gemini extraction failed: %s", e)
            await safe_send({"type": "error", "stage": "gemini", "detail": str(e)[:300]})
            return False

        log.info("gemini extraction done (%.2fs)", time.monotonic() - start)
        if covered == start_covered:  # else a transcript edit re-based the transcript meanwhile
            covered += used
            seen_partial = partial_snapshot if with_partial else ""
        used_manual = manual_snapshot
        n_topics = len(topics)
        added = apply_update(topics, update, current_full)
        if len(topics) > n_topics:
            topic_started = time.monotonic()
        if added:
            await safe_send({"type": "diagram", "topics": topics, "new_ids": added, "source_text": text})
            await persist_map(text)
        else:
            await safe_send({"type": "empty"})
        return True

    async def extraction_loop():
        backoff_skips_remaining = 0
        last_extracted = ""
        last_attempt = 0.0  # monotonic time of the last Gemini *attempt* (success or not)
        while True:
            forced = False
            try:
                await asyncio.wait_for(force_event.wait(), timeout=EXTRACTION_INTERVAL_SECONDS)
                forced = True
            except asyncio.TimeoutError:
                pass
            force_event.clear()

            text, used, with_partial = pending_speech()
            log.info("[TRACE] timer tick (forced=%s): new speech=%d chars", forced, len(text))
            if stopping:
                # Final pass after Stop: everything still pending, in as many
                # updates as that takes. Once per session, so it skips the gap
                # floor and backoff.
                while text and text != last_extracted:
                    last_extracted = text
                    if not await extract_and_send(text, used, with_partial):
                        break
                    text, used, with_partial = pending_speech()
                await safe_send({"type": "stopped"})
                return
            if not text:
                continue
            if backoff_skips_remaining > 0 and not forced:
                backoff_skips_remaining -= 1
                continue
            if not forced and text == last_extracted:
                continue  # nothing new since last pass, skip the Gemini call

            wait = MIN_EXTRACTION_GAP_SECONDS - (time.monotonic() - last_attempt)
            if wait > 0:
                # Hard floor, independent of `forced`: protects the API quota even
                # if someone spams the ⚡ button faster than the client-side cooldown.
                if not forced:
                    log.info("extraction skipped: MIN_EXTRACTION_GAP_SECONDS not elapsed")
                    continue
                # A ⚡ press inside the floor is delayed, not dropped: the button
                # stays "busy" until an answer arrives, so it must always get one.
                log.info("forced extraction delayed %.1fs by MIN_EXTRACTION_GAP_SECONDS", wait)
                await asyncio.sleep(wait)
                text, used, with_partial = pending_speech()
                if not text:
                    continue

            now = time.monotonic()
            last_extracted = text
            last_attempt = now
            # More pending than one update takes (a pasted transcript): carry on
            # right after, spaced by MIN_EXTRACTION_GAP_SECONDS, instead of
            # waiting a full interval per chunk.
            backlog = len(stt_chunks) - covered > used or (bool(partial_text) and not with_partial)
            ok = await extract_and_send(text, used, with_partial)
            backoff_skips_remaining = 0 if ok else MAX_BACKOFF_SKIPS
            if not ok:
                # Retry the same speech once the backoff is over; a pasted
                # transcript never changes, so "nothing new" would skip it forever.
                last_extracted = ""
            elif backlog:
                force_event.set()

    tasks = [asyncio.create_task(receive_loop()), asyncio.create_task(extraction_loop())]
    try:
        await asyncio.gather(*tasks)
    except WebSocketDisconnect:
        pass
    finally:
        # gather() doesn't cancel the other task when one raises. Without this,
        # every closed tab left its extraction_loop ticking forever.
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await stop_stt()
        log.info("browser ws disconnected")
