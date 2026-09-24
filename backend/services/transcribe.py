"""ElevenLabs Scribe v2 Realtime: server-side WebSocket relay for streaming STT.

Pattern (a) from the spec: the browser never sees ELEVENLABS_API_KEY. It streams
raw PCM16 mono 16kHz audio to *our* WebSocket; we open a second WebSocket to
Scribe per lecture session, forward audio, and hand back parsed transcript
events for backend/main.py to fold into the transcript buffer.

Endpoint / message schema below is from ElevenLabs' realtime STT docs, fetched
2026-08-25 (docs pages: /docs/api-reference/speech-to-text/v-1-speech-to-text-realtime
and /docs/eleven-api/guides/how-to/speech-to-text/realtime/server-side-streaming).
NOT hand-verified against a live key by me -- the exact field names (in
particular how `keyterms` is serialized as a query param: repeated `keyterms=x`
vs. a single comma-joined value) could not be confirmed beyond the docs text.
If Scribe rejects the connection or errors immediately, check the `error`
message text first -- it's surfaced verbatim through stt_status -- before
assuming the relay logic itself is wrong.

Uses the `websockets` library directly (async-native), never asyncio.to_thread.
"""
import os
import json
import base64
import logging
from typing import AsyncIterator, Optional
from urllib.parse import quote

import websockets

log = logging.getLogger("transcribe")

SCRIBE_URL = "wss://api.elevenlabs.io/v1/speech-to-text/realtime"
SCRIBE_MODEL_ID = os.getenv("SCRIBE_MODEL_ID", "scribe_v2_realtime")
SAMPLE_RATE = 16000  # must match the PCM the frontend actually sends

DEFAULT_BOOST_VOCAB = "backpropagation,recursion,gradient descent,neural network,base case"


def _boost_vocab() -> list[str]:
    raw = os.getenv("BOOST_VOCAB", DEFAULT_BOOST_VOCAB)
    return [term.strip() for term in raw.split(",") if term.strip()]


class ScribeConnectionError(RuntimeError):
    """Raised when the Scribe WebSocket can't be opened or auth fails."""


class ScribeRealtimeClient:
    """One instance per browser session. Not reusable after close()."""

    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key or os.getenv("ELEVENLABS_API_KEY")
        self._ws: Optional[websockets.ClientConnection] = None
        self.session_id: Optional[str] = None

    async def connect(self) -> None:
        if not self.api_key:
            raise ScribeConnectionError("ELEVENLABS_API_KEY is not set")

        params = {
            "model_id": SCRIBE_MODEL_ID,
            "audio_format": f"pcm_{SAMPLE_RATE}",
            "commit_strategy": "vad",  # server auto-commits on detected silence
            "language_code": "en",
        }
        # Every value must be percent-encoded - a raw space in e.g. a "gradient
        # descent" keyterm produces an invalid HTTP request line, which fails
        # the WebSocket handshake outright (not a JSON error frame we could
        # otherwise catch and report).
        query = "&".join(f"{k}={quote(str(v))}" for k, v in params.items())
        for term in _boost_vocab():
            query += f"&keyterms={quote(term)}"
        url = f"{SCRIBE_URL}?{query}"

        try:
            self._ws = await websockets.connect(
                url, additional_headers={"xi-api-key": self.api_key}
            )
            first = await self._ws.recv()
        except Exception as e:
            raise ScribeConnectionError(f"Scribe connect failed: {e}") from e

        data = json.loads(first)
        if data.get("message_type") == "session_started":
            self.session_id = data.get("session_id")
            log.info("scribe session started id=%s", self.session_id)
        elif data.get("message_type") in ("error", "auth_error"):
            raise ScribeConnectionError(f"Scribe rejected connection: {data.get('error')}")
        else:
            log.warning("scribe: unexpected first message %r", data)

    async def send_audio_chunk(self, pcm16_bytes: bytes) -> None:
        if not self._ws:
            raise ScribeConnectionError("not connected")
        await self._ws.send(json.dumps({
            "message_type": "input_audio_chunk",
            "audio_base_64": base64.b64encode(pcm16_bytes).decode("ascii"),
            "commit": False,  # commit_strategy=vad handles committing server-side
            "sample_rate": SAMPLE_RATE,
        }))

    async def commit(self) -> None:
        """Force-commit whatever Scribe is still holding as a partial (an empty
        chunk with commit=True, per the server-side streaming docs). The docs
        don't say whether this is honored under commit_strategy=vad, so callers
        must not assume a committed_transcript will follow."""
        if not self._ws:
            raise ScribeConnectionError("not connected")
        await self._ws.send(json.dumps({
            "message_type": "input_audio_chunk",
            "audio_base_64": "",
            "commit": True,
            "sample_rate": SAMPLE_RATE,
        }))

    async def events(self) -> AsyncIterator[dict]:
        """Yields parsed server->client messages until the connection closes."""
        if not self._ws:
            raise ScribeConnectionError("not connected")
        async for raw in self._ws:
            try:
                yield json.loads(raw)
            except json.JSONDecodeError:
                log.warning("scribe: non-JSON message ignored: %r", raw[:200])

    async def close(self) -> None:
        if self._ws:
            try:
                await self._ws.close()
            finally:
                self._ws = None
