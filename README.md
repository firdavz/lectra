# Lecture → Diagram

Speak through a lecture → server-relayed live transcription (ElevenLabs Scribe)
→ Gemini spots the "hard part" and turns it into a small flowchart → shown
live on an interactive canvas (Cytoscape.js) → every diagram is persisted with
the exact transcript excerpt it came from, browsable via a small REST API.

## Quick start
```powershell
.\start.ps1
```
Then open **http://localhost:8010/** (redirects to the app) in **Chrome**.
Needs `GEMINI_API_KEY` and `ELEVENLABS_API_KEY` in `.env` (copy from
`.env.example` — see [Config](#config) below).

Click **🎤** and talk; click it again to stop. A flowchart appears roughly
every 20s once you've explained something (greetings and logistics like "can
you hear me" correctly produce nothing). Hit **⚡** to generate one right away.

On the diagram: drag boxes to move them, scroll to zoom, drag empty space to
pan. **⤢ Fit** brings everything back into view, **↻ Tidy** re-arranges the
boxes, **📄 Source** shows the exact transcript excerpt it was built from.

**No mic?** `POST /api/process` (see [REST API](#rest-api-phase-4)) runs the
same Gemini extraction on pasted text.

## What's verified (as of 2026-09-25)

| Piece | Status |
|---|---|
| Mic → Scribe → Gemini → diagram, end to end | ✅ Live: real speech in the browser, and a synthesized 37s lecture streamed over the WebSocket like the browser does |
| Stop keeps the last sentence (Scribe commit, then one final extraction) | ✅ Live against Scribe (it honors the manual commit under VAD); the no-commit fallback with a fake Scribe |
| Speech Scribe hasn't committed yet still feeds extraction | ✅ Live: 36s with no VAD commit still produced an extraction at the 20s tick |
| Closing a tab stops its extraction loop | ✅ With a fake Scribe, and shown to fail on the code before the fix |
| Gemini output shape enforced via `response_json_schema`; Pydantic still checks edges point at real nodes | ✅ Even a prompt telling the model to drop `to` gets `to` back with the schema |
| Interactive canvas: render, drag, wheel zoom, pan, Fit, Tidy, Source, identical re-render keeps a dragged layout, hostile labels, window resize | ✅ Headless Chrome driving the real page with real mouse events |
| REST API + SQLite persistence | ✅ Live |
| Automated tests in the repo | ❌ None yet — the checks above ran from throwaway scripts |

## Config

`.env` (copy from `.env.example`):
```
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.5-flash-lite
ELEVENLABS_API_KEY=

EXTRACTION_INTERVAL_SECONDS=20
BUFFER_WINDOW_SECONDS=60
MIN_EXTRACTION_GAP_SECONDS=8
BOOST_VOCAB=backpropagation,recursion,gradient descent,neural network,base case

DATABASE_URL=sqlite+aiosqlite:///./lecture.db
```
- `GEMINI_MODEL` — single place to change if the model gets sunset again; a
  model-not-found error now names this exact variable in the error message.
- `BUFFER_WINDOW_SECONDS` — the transcript buffer is a sliding window:
  extraction runs over the last N seconds of live speech, not the whole
  lecture (so it isn't cleared after every extraction — an explanation that
  crosses a timer boundary still gets extracted as one coherent piece). Text
  sent as a `manual_text` WebSocket message (no UI for it currently) is not
  windowed.
- `MIN_EXTRACTION_GAP_SECONDS` — hard floor between Gemini calls, enforced
  server-side. Protects the API quota even if the ⚡ button is spammed faster
  than its own client-side cooldown; a ⚡ press inside the gap waits it out
  instead of being dropped.
- `BOOST_VOCAB` — comma-separated terms passed to Scribe as vocabulary hints.
- `DATABASE_URL` — SQLite (async, via `aiosqlite`) connection string for
  session/diagram/transcript persistence. Defaults to a file next to the repo.

## Setup (if not using start.ps1)
```
pip install -r requirements.txt
copy .env.example .env   # fill in your keys
uvicorn backend.main:app --port 8010
```

## REST API (Phase 4)
- `POST /api/sessions` `{title?}` → create a session
- `GET /api/sessions` → list sessions, newest first
- `GET /api/sessions/{id}` → session + its diagrams + its transcript chunks
- `GET /api/diagrams/{id}` / `DELETE /api/diagrams/{id}`
- `POST /api/process` `{text}` (20,000 char cap) → runs one Gemini extraction
  immediately, persists it under its own session, returns the diagram. Useful
  for testing the pipeline without the live WS/mic flow.

Every diagram stored (live or via `/api/process`) carries its `source_text` —
the exact excerpt that was sent to Gemini to produce it. The frontend's
**📄 Source** button reads this straight off the live WS message; the REST API
is the same data for anything already persisted.

## Known issues / things to know
- **Corporate/Avast SSL interception**: this machine's Avast antivirus MITMs
  HTTPS for scanning. Fixed via `pip-system-certs`, which patches Python's SSL
  layer globally (via `truststore`) — covers `google-genai`, `websockets`,
  *and* `aiosqlite`'s file I/O isn't network-facing so it's unaffected either
  way. Already wired into `backend/main.py`. If you move this to another
  machine and see `SSLCertVerificationError`, that's why.
- **Scribe not connecting?** Read the `stt_status` error detail first — it's
  the raw error text from ElevenLabs, which will usually say exactly what's
  wrong (auth, bad query param, unsupported audio format, etc).
- **20s extraction interval, 60s sliding window, 8s hard floor**: conservative
  guesses, not measured limits. Adjust in `.env` if it feels sluggish or
  you're burning quota too fast.
- Gemini model used: `gemini-3.5-flash-lite` (configurable — see Config).
  Its free tier allows 15 requests/minute; the app uses about 3/minute. The
  system prompt asks for 4–10 nodes and ~6-word labels, diagrams any
  explanation (even informal cause and effect), and returns an empty graph
  only for greetings, logistics and small talk.
- No auth of any kind — anyone who can reach the server can read/delete any
  session or diagram via the REST API. Fine for local/single-user use; would
  need addressing before deploying this anywhere multi-user or public.
- Tavily was explored in an earlier version and removed — no working key was
  ever found for it and it wasn't wired into anything.

## Architecture
```
frontend/index.html    Browser: mic capture (getUserMedia -> downsample to
                        16kHz PCM16 -> binary WS frames) -> WebSocket ->
                        draws the flowchart on a Cytoscape.js canvas with a
                        dagre layout (drag/zoom/pan, Fit, Tidy, Source view;
                        skips identical re-renders), shows live transcript,
                        recording timer and next-diagram countdown
backend/main.py         FastAPI + WebSocket: relays audio to Scribe, keeps a
                        sliding-window transcript buffer, runs Gemini
                        extraction on a timer (or on-demand via force),
                        persists transcript chunks + diagrams as they happen
backend/api.py          REST: sessions/diagrams CRUD-ish + POST /api/process
backend/db.py           SQLModel tables (sessions, diagrams, transcript_chunks)
                        + async SQLite engine/session helpers
backend/services/
  transcribe.py          ElevenLabs Scribe v2 Realtime WS relay client
  diagram.py              Async Gemini call -> Pydantic-validated
                           {nodes, edges} JSON (GeminiParseError on anything
                           that doesn't fit the strict schema)
```

## Roadmap (not built yet)
- Auth of any kind (see "Known issues" above) — anyone reaching the server
  has full read/delete access to every session and diagram.
- Rate limiting / hardening beyond the Gemini-call floor already in place
  (no request-level throttling on the REST API, no security headers).
