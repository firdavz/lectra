"""FastAPI app: live transcript text in (from browser speech API) -> live flowchart JSON out."""
import asyncio
import pip_system_certs.wrapt_requests  # trust Windows cert store (fixes Avast SSL-scan MITM)
from pathlib import Path
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles

load_dotenv()

from backend.services.diagram import extract_flowchart

app = FastAPI()

FRONTEND_DIR = Path(__file__).parent.parent / "frontend"
app.mount("/static", StaticFiles(directory=FRONTEND_DIR, html=True), name="static")

EXTRACTION_INTERVAL_SECONDS = 20  # ~3 calls/min: stays well under Gemini free-tier's
# ~10 RPM cap, and under a ~2hr live lecture keeps total calls within the free
# tier's daily request budget (reportedly as low as ~250/day for flash models
# on the free tier as of late-2025 quota cuts).
MAX_BACKOFF_SKIPS = 6  # after an error (e.g. rate-limited), wait up to 6 extra
# cycles (~2 more minutes) before trying again, instead of hammering an API
# that's already saying no.


@app.websocket("/ws/lecture")
async def lecture_ws(ws: WebSocket):
    await ws.accept()
    state = {"transcript": "", "last_extracted": ""}
    force_event = asyncio.Event()

    async def receive_loop():
        while True:
            msg = await ws.receive_json()
            state["transcript"] = msg.get("text", state["transcript"])
            if msg.get("force"):
                force_event.set()

    async def run_extraction(transcript: str) -> bool:
        """Returns True on success, False on error (caller uses this to back off)."""
        state["last_extracted"] = transcript
        try:
            # NOTE: called inline (not via asyncio.to_thread) -- on Windows the
            # Avast-cert-trust patch (pip-system-certs) hangs when its Windows
            # cert-store lookup runs on a non-main thread. Blocks the event loop
            # for a couple seconds per call, which is fine for one runner.
            diagram = extract_flowchart(transcript)
        except Exception as e:
            await ws.send_json({"type": "error", "message": str(e)[:300]})
            return False
        if diagram.get("nodes"):
            await ws.send_json({"type": "diagram", "data": diagram})
        else:
            await ws.send_json({"type": "empty"})
        return True

    async def extraction_loop():
        backoff_skips_remaining = 0
        while True:
            forced = False
            try:
                await asyncio.wait_for(force_event.wait(), timeout=EXTRACTION_INTERVAL_SECONDS)
                forced = True
            except asyncio.TimeoutError:
                pass
            force_event.clear()

            transcript = state["transcript"]
            if not transcript:
                continue

            if backoff_skips_remaining > 0 and not forced:
                # Recently errored (likely rate-limited) - ride out the extra
                # cooldown before spending another call, unless the runner
                # explicitly asked for one via the force button.
                backoff_skips_remaining -= 1
                continue

            if not forced and transcript == state["last_extracted"]:
                continue  # nothing new since last pass, skip the Gemini call

            ok = await run_extraction(transcript)
            backoff_skips_remaining = 0 if ok else MAX_BACKOFF_SKIPS

    try:
        await asyncio.gather(receive_loop(), extraction_loop())
    except WebSocketDisconnect:
        pass
