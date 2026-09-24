"""FastAPI app: live mic audio in (relayed to ElevenLabs Scribe) or typed text in
-> live flowchart JSON out, over one WebSocket per browser tab.
"""
import asyncio
import json
import logging
import os
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
from backend.services.diagram import extract_flowchart, ModelNotFoundError, GeminiParseError
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
BUFFER_WINDOW_SECONDS = int(os.getenv("BUFFER_WINDOW_SECONDS", "60"))
MIN_EXTRACTION_GAP_SECONDS = int(os.getenv("MIN_EXTRACTION_GAP_SECONDS", "8"))
# Hard floor on Gemini calls, enforced server-side regardless of how fast the
# client sends "force" messages -- the frontend's own cooldown is a courtesy,
# not something this loop trusts.
MAX_BACKOFF_SKIPS = 6  # after a Gemini error, wait up to this many extra cycles
# before trying again, instead of hammering an API that's already saying no.

# Errors from Scribe that mean "stop trying, this session is dead" vs. transient.
_SCRIBE_FATAL_ERRORS = {"auth_error", "unaccepted_terms", "quota_exceeded"}

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

    stt_chunks: list[tuple[float, str]] = []  # (monotonic ts, final transcript text) from Scribe
    manual_text = ""  # whole current contents of the manual fallback textarea
    last_persisted_manual = ""  # last manual_text snapshot already written as a transcript_chunks row
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

    async def persist_diagram(graph: dict, source_text: str):
        if not session_id:
            return
        try:
            await db.add_diagram(session_id, json.dumps(graph), source_text)
        except Exception:
            log.exception("failed to persist diagram")

    def window_text() -> str:
        """Sliding-window transcript: last BUFFER_WINDOW_SECONDS of Scribe speech,
        plus whatever's currently in the manual fallback box (untimed, always included)."""
        cutoff = time.monotonic() - BUFFER_WINDOW_SECONDS
        stt_chunks[:] = [(t, s) for t, s in stt_chunks if t >= cutoff]  # prune while we're here
        combined = " ".join(s for _, s in stt_chunks)
        if manual_text:
            combined = f"{combined} {manual_text}".strip()
        return combined.strip()

    async def scribe_recv_loop(client: ScribeRealtimeClient):
        try:
            async for event in client.events():
                mtype = event.get("message_type")
                if mtype in ("committed_transcript", "final_transcript"):
                    text = (event.get("text") or "").strip()
                    if text:
                        now = time.monotonic()
                        stt_chunks.append((now, text))
                        log.info("[TRACE] text entered buffer via stt (len=%d chars): %r", len(text), text[:80])
                        await safe_send({"type": "transcript_chunk", "text": text, "source": "scribe"})
                        await persist_chunk(text, "stt")
                elif mtype == "partial_transcript":
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

    async def stop_stt():
        task = scribe["task"]
        client = scribe["client"]
        scribe["task"] = None
        scribe["client"] = None
        if task:
            task.cancel()
        if client:
            await client.close()

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
        nonlocal manual_text
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            return
        mtype = msg.get("type")
        if mtype == "manual_text":
            manual_text = msg.get("text", "")
            log.info("[TRACE] text entered buffer via manual box (len=%d chars)", len(manual_text))
        elif mtype == "transcript_edit":
            # A teacher/student fixed a mis-heard word in the live transcript.
            # Replace the whole rolling STT buffer with the corrected text (as
            # one fresh chunk) so the *next* extraction reads the correction,
            # not the original mis-transcription.
            corrected = (msg.get("text") or "").strip()
            stt_chunks[:] = [(time.monotonic(), corrected)] if corrected else []
            log.info("transcript corrected by user (len=%d chars)", len(corrected))
            await persist_chunk(corrected, "correction")
        elif mtype == "force":
            force_event.set()
        elif mtype == "stt_start":
            await start_stt()
        elif mtype == "stt_stop":
            await stop_stt()

    async def receive_loop():
        while True:
            message = await ws.receive()
            if message["type"] == "websocket.disconnect":
                raise WebSocketDisconnect(message.get("code", 1000))
            if message.get("bytes") is not None:
                await handle_audio_chunk(message["bytes"])
            elif message.get("text") is not None:
                await handle_text_message(message["text"])

    async def extraction_loop():
        nonlocal last_persisted_manual
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

            text = window_text()
            log.info("[TRACE] timer tick (forced=%s): buffer=%d chars", forced, len(text))
            if not text:
                continue
            if backoff_skips_remaining > 0 and not forced:
                backoff_skips_remaining -= 1
                continue
            if not forced and text == last_extracted:
                continue  # nothing new since last pass, skip the Gemini call

            now = time.monotonic()
            if now - last_attempt < MIN_EXTRACTION_GAP_SECONDS:
                # Hard floor, independent of `forced`: protects the API quota even
                # if someone spams the ⚡ button faster than the client-side cooldown.
                log.info("extraction skipped: MIN_EXTRACTION_GAP_SECONDS not elapsed (%.1fs since last attempt)",
                          now - last_attempt)
                continue

            last_extracted = text
            last_attempt = now
            start = now
            if manual_text and manual_text != last_persisted_manual:
                # One transcript_chunks row per distinct manual-box snapshot that
                # actually fed an extraction -- not per keystroke.
                await persist_chunk(manual_text, "manual")
                last_persisted_manual = manual_text
            log.info("[TRACE] extraction started (len=%d chars): %r", len(text), text[:80])
            try:
                diagram = await extract_flowchart(text)
            except ModelNotFoundError as e:
                log.error("gemini model error: %s", e)
                await safe_send({"type": "error", "stage": "gemini", "detail": str(e)})
                backoff_skips_remaining = MAX_BACKOFF_SKIPS
                continue
            except GeminiParseError as e:
                # Invalid/unparseable JSON from Gemini: narrower stage so the
                # frontend can distinguish it from a network/auth/model error.
                # Previous diagram on screen is left untouched -- we simply
                # don't send a "diagram" message this cycle.
                log.error("gemini parse error: %s", e)
                await safe_send({"type": "error", "stage": "gemini_parse", "detail": str(e)[:300]})
                backoff_skips_remaining = MAX_BACKOFF_SKIPS
                continue
            except Exception as e:
                log.error("gemini extraction failed: %s", e)
                await safe_send({"type": "error", "stage": "gemini", "detail": str(e)[:300]})
                backoff_skips_remaining = MAX_BACKOFF_SKIPS
                continue

            log.info("gemini extraction done (%.2fs)", time.monotonic() - start)
            backoff_skips_remaining = 0
            if diagram.get("nodes"):
                await safe_send({"type": "diagram", "graph": diagram, "source_text": text})
                await persist_diagram(diagram, text)
            else:
                await safe_send({"type": "empty"})

    try:
        await asyncio.gather(receive_loop(), extraction_loop())
    except WebSocketDisconnect:
        pass
    finally:
        await stop_stt()
        log.info("browser ws disconnected")
