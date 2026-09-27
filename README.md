# Lecture → Diagram

Speak through a lecture → server-relayed live transcription (ElevenLabs Scribe)
→ Gemini grows a **lecture map** in simple English for students still learning
the language: one small diagram per subtopic, side by side, nothing ever
dropped, each drawn in the shape that fits its content → shown live on an interactive canvas (Cytoscape.js) with a quiz made
from the map → every map update is persisted with the speech it came from,
browsable via a small REST API.

## Quick start
```powershell
.\start.ps1
```
Then open **http://localhost:8010/** (redirects to the app) in **Chrome**.
Needs `GEMINI_API_KEY` and `ELEVENLABS_API_KEY` in `.env` (copy from
`.env.example` — see [Config](#config) below).

Click **🎤** and talk; click it again to stop (Start again carries on the same
map; reload the page for a new one). Roughly every 20s the map grows with what
you explained (greetings and logistics like "can you hear me" add nothing).
Hit **⚡** to update it right away. New boxes glow for a few seconds; a new
subtopic — or the same one after 5 minutes or 10 boxes — starts a new group to
the right. Each topic is drawn in the shape that fits it, picked by Gemini:
⚙️ **process** (steps and causes, top to bottom), ⏳ **timeline** (events in
order, left to right, e.g. a life story), 💡 **concept** (a main idea in the
middle with its parts around it), ⚖️ **comparison** (the compared things above
their features). Introductions, adverts and talk about the video itself are
skipped.

On the map: scroll or drag empty space to move around, pinch or Ctrl + scroll
to zoom (or − / + at the bottom right), drag boxes or whole topics to
rearrange. **⤢** shows the whole map and follows new boxes again, **↻ Tidy**
re-arranges everything, **📄 Source** shows the speech behind the newest
boxes. The **Quiz** panel asks fill-the-gap questions built from the map's own
arrows and highlights the answer on the map.

**No mic, or a ready transcript?** Click **✎** in the transcript card, paste
or type the text, then press **⚡** next to ✓: the map is built from it right
away, without the mic — a long text over several updates, a paragraph at a
time, so each paragraph tends to become its own topic. **✓** only saves (while
listening, anything new in it is picked up at the next update). Fixing a word
in text the map already covers doesn't add boxes twice.

## What's verified (as of 2026-09-25)

| Piece | Status |
|---|---|
| Mic → Scribe → Gemini → diagram, end to end | ✅ Live: real speech in the browser, and a synthesized 37s lecture streamed over the WebSocket like the browser does |
| Stop keeps the last sentence (Scribe commit, then one final extraction) | ✅ Live against Scribe (it honors the manual commit under VAD); the no-commit fallback with a fake Scribe |
| Speech Scribe hasn't committed yet still feeds extraction | ✅ Live: 36s with no VAD commit still produced an extraction at the 20s tick |
| Closing a tab stops its extraction loop | ✅ With a fake Scribe, and shown to fail on the code before the fix |
| Gemini output shape enforced via `response_json_schema`; Pydantic still checks edges point at real nodes | ✅ Even a prompt telling the model to drop `to` gets `to` back with the schema |
| Growing map rules: boxes only added, duplicates reused, bad arrows dropped, full topic continues in a new group, resume validation | ✅ 22 unit checks on `backend/services/topics.py` |
| Live loop sends only speech the map doesn't cover yet; map grows across updates; resume after reconnect; pasted transcript split into updates (each sentence once, in order), corrections not re-sent; a hung Gemini call cut off after 30s and retried | ✅ WebSocket integration test with a fake Scribe and fake Gemini (26 checks) |
| Diagram kinds, real Gemini | ✅ 4 transcripts: a biography video became a concept overview + a timeline (its "improve your English" hook skipped), photosynthesis a process, plant vs animal cells a comparison with shared features linked to both, "what is an ecosystem" a two-level concept map. Layouts per kind checked in headless Chrome (10 checks) |
| Paste + ⚡ with the mic off, real Gemini | ✅ Headless Chrome on the running app: the 6-paragraph elephant speech became 6 matching topics, 22 boxes, in about a minute |
| Simple-English prompt on a real lecture (elephant talk, 6 pieces) | ✅ Live Gemini: arrows read as simple sentences ("Mud bath protects Wrinkled skin"), topics split by subject; the occasional odd arrow remains |
| Lecture map canvas: topic groups side by side, finished topics never move, scroll = move / pinch = zoom around the pointer, zoom buttons, follow mode, Tidy, Source, glow, quiz (answers, highlight, no ambiguous options), resume on reconnect | ✅ 45 checks in headless Chrome driving the real page with real mouse events |
| REST API + SQLite persistence | ✅ Live |
| Automated tests in the repo | ❌ None yet — the checks above ran from throwaway scripts |

## Config

`.env` (copy from `.env.example`):
```
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.5-flash-lite
ELEVENLABS_API_KEY=

EXTRACTION_INTERVAL_SECONDS=20
MIN_EXTRACTION_GAP_SECONDS=8
BOOST_VOCAB=backpropagation,recursion,gradient descent,neural network,base case

DATABASE_URL=sqlite+aiosqlite:///./lecture.db
```
- `GEMINI_MODEL` — single place to change if the model gets sunset again; a
  model-not-found error now names this exact variable in the error message.
- `EXTRACTION_INTERVAL_SECONDS` — how often the map grows. Each update sends
  Gemini the current topic, the tail of what the map already covers, and only
  the speech since the last update. Text sent as a `manual_text` WebSocket
  message (no UI for it currently) counts as new speech once.
- Topic size: a new group starts after 10 boxes or 5 minutes
  (`MAX_NODES_PER_TOPIC`, `MAX_TOPIC_SECONDS` in `backend/services/topics.py`).
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
- `POST /api/process` `{text}` (20,000 char cap) → builds a lecture map from
  the text in one Gemini call, persists it under its own session, returns it
  (`diagram.graph` is `{"topics": [...]}`). Useful for testing the pipeline
  without the live WS/mic flow.

Every diagram row is a snapshot of the whole map after one update
(`{"topics": [...]}`), with its `source_text` — the new speech that update was
built from. The frontend's **📄 Source** button reads this straight off the
live WS message; the REST API is the same data for anything already persisted.

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
- **20s extraction interval, 8s hard floor**: conservative guesses, not
  measured limits. A Gemini call that doesn't answer within 30s is reported
  as an error and retried after the backoff (the SDK's own retries are cut
  to 3 quick attempts; its defaults could hang for minutes). Adjust in `.env` if it feels sluggish or
  you're burning quota too fast.
- Gemini model used: `gemini-3.5-flash-lite` (configurable — see Config).
  Its free tier allows 15 requests/minute; the app uses about 3/minute. The
  system prompt picks a diagram kind per topic (process, timeline, concept,
  comparison) with writing rules for each, asks for simple everyday words,
  every "box → arrow → box" to read as a true simple sentence, names instead
  of roles, emoji only on concrete things, and nothing for greetings,
  logistics, adverts or talk about the video itself.
- No auth of any kind — anyone who can reach the server can read/delete any
  session or diagram via the REST API. Fine for local/single-user use; would
  need addressing before deploying this anywhere multi-user or public.
- Tavily was explored in an earlier version and removed — no working key was
  ever found for it and it wasn't wired into anything.

## Architecture
```
frontend/index.html    The page's markup: controls, transcript, map, quiz
frontend/styles.css     All styling; every colour is a design token in :root
                        (the canvas reads them too)
frontend/app.js         Browser logic: mic capture (getUserMedia -> downsample
                        to 16kHz PCM16 -> binary WS frames) -> WebSocket ->
                        draws the lecture map on a Cytoscape.js canvas (topic
                        groups, each in its kind's layout: dagre top-down or
                        left-right, radial tree for concepts; only new boxes
                        added; scroll to move, pinch to zoom, Fit/Tidy/Source),
                        quiz panel, live transcript, paste + ⚡, recording
                        timer, next-update countdown; sends the map back on
                        reconnect
backend/main.py         FastAPI + WebSocket: relays audio to Scribe, keeps a
                        tracks which speech the map already covers, grows
                        the map on a timer (or on-demand via force), persists
                        transcript chunks + map snapshots as they happen
backend/api.py          REST: sessions/diagrams CRUD-ish + POST /api/process
backend/db.py           SQLModel tables (sessions, diagrams, transcript_chunks)
                        + async SQLite engine/session helpers
backend/services/
  transcribe.py          ElevenLabs Scribe v2 Realtime WS relay client
  diagram.py              Async Gemini call: map so far + new speech ->
                           schema-enforced "what to add" JSON
                           (GeminiParseError on anything that doesn't fit)
  topics.py               The lecture map: merges Gemini's additions (topics
                           and their kinds, box ids, duplicates, topic size
                           limits), no I/O
```

## Roadmap (not built yet)
- Auth of any kind (see "Known issues" above) — anyone reaching the server
  has full read/delete access to every session and diagram.
- Rate limiting / hardening beyond the Gemini-call floor already in place
  (no request-level throttling on the REST API, no security headers).
