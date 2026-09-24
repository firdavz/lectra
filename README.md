# Lecture → Diagram

Speak through a lecture → server-relayed live transcription (ElevenLabs Scribe)
→ Gemini spots the "hard part" and turns it into a small flowchart → renders
live with Mermaid → every diagram is persisted with the exact transcript
excerpt it came from, browsable via a small REST API.

## Quick start
```powershell
.\start.ps1
```
Then open **http://localhost:8010/** (redirects to the app) in **Chrome**.
Needs `GEMINI_API_KEY` and `ELEVENLABS_API_KEY` in `.env` (copy from
`.env.example` — see [Config](#config) below).

Click **▶ Start listening** and talk. A flowchart appears roughly every 20s
once you've said something with actual conceptual content (a throwaway
sentence like "hi everyone" correctly produces nothing — that's the model
being selective, not broken). Hit **⚡ Generate now** to skip the wait. Click
the diagram itself to see the exact transcript excerpt it was built from.

**No mic, or STT isn't picking anything up?** Type/paste lecture text into the
box under the transcript panel — it feeds the exact same pipeline.

## What's actually verified vs. what isn't

This session had **real `GEMINI_API_KEY`/`ELEVENLABS_API_KEY` values in
`.env`** and Gemini was exercised repeatedly against the live API, but **no
connected browser** was available to click through the actual UI, so
everything below was verified either with real Gemini calls over a scripted
WebSocket/HTTP client, or with the real frontend `<script>` executed in a
Node.js harness with stubbed DOM elements (not a real browser/mermaid render).

| Piece | Status |
|---|---|
| No Graphviz remnants anywhere in the repo; Mermaid is the only renderer | ✅ Verified (repo-wide grep, clean) |
| WS diagram contract `{"type":"diagram","graph":{...},"source_text":"..."}` | ✅ Verified against the live server with a real Gemini call |
| Mermaid sanitization (quotes, brackets, `-->`, backticks, non-ASCII) in labels **and** ids | ✅ Verified two ways: (1) the real `sanitizeLabel`/`sanitizeId` functions executed against hostile input in a Node harness, all cases pass; (2) a real Gemini call fed a hostile-text transcript and the resulting labels sanitized cleanly |
| Async Gemini call doesn't block the event loop | ✅ Verified live: audio-chunk log lines interleave with an in-flight multi-second Gemini call (see server log timestamps in this session's transcript) |
| Pydantic strict-schema validation of Gemini's JSON (dangling edge refs, missing fields, non-str ids all rejected/coerced correctly) | ✅ Verified with direct unit tests against `FlowchartGraph` |
| `GEMINI_MODEL` misconfiguration → clean `{"type":"error","stage":"gemini"}`, session survives, next message still works | ✅ Verified live against the real API with a deliberately bad model name |
| `MIN_EXTRACTION_GAP_SECONDS` hard floor holds even under force-spam | ✅ Verified via server log: attempt-to-attempt gaps ≥ 8s, pending forces inside the floor correctly skipped |
| Frontend: identical diagram doesn't re-render; a genuinely new one does; click toggles the source-text view | ✅ Verified by executing the real (unmodified) `<script>` block from `frontend/index.html` in a Node.js DOM-stub harness |
| Recording timer (`MM:SS`, freezes on Stop, resets on Start) and "next diagram in Ns" countdown (resets on any extraction, ticks independent of WS) | ✅ Verified the same way, including real 1-second ticks |
| SQLite persistence: sessions/diagrams/transcript_chunks; every diagram's `source_text` matches its input; survives a server restart | ✅ Verified live end-to-end, including an actual server restart and re-fetch |
| REST API (`POST/GET /api/sessions`, `GET /api/sessions/{id}`, `GET`/`DELETE /api/diagrams/{id}`, `POST /api/process`, 20k char cap) | ✅ Verified live against the running server, including the 422 on an oversized `/api/process` body |
| `start.ps1` one-command launch (installs the new `sqlmodel`/`aiosqlite`/`pydantic` deps, boots, serves, DB works) | ✅ Actually run this session via `.\start.ps1` itself (not a manual uvicorn invocation) |
| Mermaid actually rendering pixels in a real browser (vs. the Node-harness proof above) | ⚠️ **Not verified in a real browser.** No browser extension was connected this session. The DOM-stub harness proves the *logic* (skip/re-render/toggle decisions, string construction) is correct, but not that Mermaid itself paints the SVG without a console error — Mermaid's own parser wasn't exercised, only our code that feeds it. |
| **ElevenLabs Scribe v2 Realtime connection** (URL, auth, message schema) | ❌ **Still not verified against the live API.** Implemented from ElevenLabs' published docs, not exercised this session (this session's testing used the manual-text fallback path exclusively, per the "don't touch STT" instruction). See the warning comment at the top of `backend/services/transcribe.py`. |
| **Mic capture → PCM16 downsample → audio actually reaching Scribe → real transcript** | ❌ **Not verified at all.** No connected browser, and out of scope for this session (STT is owned by a separate session/prompt). Needs a human + Chrome to confirm. |

**Next step to actually close the remaining gaps:** open Chrome, run
`.\start.ps1`, click **Start listening**, and talk for 90 seconds. If Scribe
rejects the connection, the exact error text comes back in the `stt_status`
message and in the server log. Also worth a real click-through: does Mermaid
actually render the flowchart pixels, does the fade-in look right, does the
timer/countdown look right in the browser (not just in the Node harness)?

## Config

`.env` (copy from `.env.example`):
```
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.6-flash
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
  crosses a timer boundary still gets extracted as one coherent piece). The
  manual text box is not windowed (always included in full).
- `MIN_EXTRACTION_GAP_SECONDS` — hard floor between Gemini calls, enforced
  server-side. Protects the API quota even if the ⚡ button is spammed faster
  than its own client-side cooldown.
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
the exact excerpt that was sent to Gemini to produce it. The frontend's "click
the diagram" trust feature reads this straight off the live WS message; the
REST API is the same data for anything already persisted.

## Known issues / things to know
- **Corporate/Avast SSL interception**: this machine's Avast antivirus MITMs
  HTTPS for scanning. Fixed via `pip-system-certs`, which patches Python's SSL
  layer globally (via `truststore`) — covers `google-genai`, `websockets`,
  *and* `aiosqlite`'s file I/O isn't network-facing so it's unaffected either
  way. Already wired into `backend/main.py`. If you move this to another
  machine and see `SSLCertVerificationError`, that's why.
- **Scribe integration is doc-derived, not test-verified.** If it doesn't
  connect, read the `stt_status` error detail first — it's the raw error text
  from ElevenLabs, which will usually say exactly what's wrong (auth, bad
  query param, unsupported audio format, etc).
- **20s extraction interval, 60s sliding window, 8s hard floor**: conservative
  guesses, not measured limits. Adjust in `.env` if it feels sluggish or
  you're burning quota too fast.
- Gemini model used: `gemini-3.6-flash` (configurable — see Config). The
  system prompt asks for 4–10 nodes, ~6-word labels, and a strict empty-JSON
  response for filler talk with no real structure.
- No auth of any kind — anyone who can reach the server can read/delete any
  session or diagram via the REST API. Fine for local/single-user use; would
  need addressing before deploying this anywhere multi-user or public.
- Tavily was explored in an earlier version and removed — no working key was
  ever found for it and it wasn't wired into anything.

## Architecture
```
frontend/index.html    Browser: mic capture (getUserMedia -> downsample to
                        16kHz PCM16 -> binary WS frames) or manual text box
                        -> WebSocket -> renders Mermaid flowchart (skips
                        identical re-renders, fades in real changes), shows
                        live transcript, recording timer, next-diagram
                        countdown, and a click-to-reveal source-text view
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
