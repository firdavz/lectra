# Lecture → Diagram

Speak through a lecture → the browser transcribes live → Gemini spots the
"hard part" and turns it into a small flowchart → renders live with Mermaid.

## Quick start
```powershell
.\start.ps1
```
Then open **http://localhost:8010/static/index.html** in **Chrome** (Web
Speech API is Chrome/Edge-only; needs a real `GEMINI_API_KEY` in `.env`,
already set up).

Click **▶ Start listening** and talk. A flowchart appears roughly every 20s
once you've said something with actual conceptual content in it (a throwaway
sentence like "hi everyone" correctly produces nothing — that's the model
being selective, not broken). Hit **⚡ Generate diagram now** to skip the wait.

**No mic, or recognition isn't picking anything up?** Type/paste lecture text
into the box under the transcript — it feeds the exact same pipeline. This
path is proven end-to-end (see below) and is the reliable fallback if the
live mic doesn't cooperate for any reason.

## What's actually verified vs. what isn't

I could drive this whole app headlessly and check every piece **except one**,
so here's the honest picture rather than a blanket "it works":

| Piece | Status |
|---|---|
| Transcript text → Gemini → flowchart JSON | ✅ Verified with real API calls, real content (backprop, recursion examples both produced correct diagrams) |
| Mermaid rendering, incl. malformed/quote-y LLM labels | ✅ Verified — sanitizes both labels and node ids now |
| WebSocket reconnect (dropped wifi, phone sleep) | ✅ Verified |
| Manual-text-input fallback (paste → diagram) | ✅ Verified through the real UI, real Gemini call |
| `start.ps1` one-command launch | ✅ Actually run, confirmed clean startup |
| Mic permission → audio actually reaching the browser | ✅ Verified (measured real audio signal via getUserMedia) |
| **Browser SpeechRecognition transcribing real speech** | ⚠️ **Not verified.** This is the one link I can't test without a human voice and a real Chrome window — headless/automated Chrome's speech engine behaves differently (a fresh automated profile hasn't downloaded the on-device recognition model, and diagnostics showed the recognizer reaching Google's service and getting real "no speech detected" responses, not silently failing — so permissions/network/plumbing are all fine, it's specifically the recognition-from-synthetic-audio step that doesn't work under automation). This is the same Web Speech API used by dictation in every Chrome install — it should just work when you actually talk into it, but if it doesn't, use the text box. |

If the live mic doesn't work when you test it: type a sentence into the
fallback box first to confirm the rest of the pipeline is alive, then debug
the mic separately (check the address bar's mic icon for permission, check
`chrome://settings/content/microphone`).

## Setup (if not using start.ps1)
```
pip install -r requirements.txt
copy .env.example .env   # fill in GEMINI_API_KEY (already done in .env)
uvicorn backend.main:app --port 8010
```

## Known issues / things to know
- **Corporate/Avast SSL interception**: this machine's Avast antivirus
  MITMs HTTPS for scanning. Fixed via `pip-system-certs` (trusts the Windows
  cert store). Already wired into `backend/main.py`. If you move this to
  another machine and see `SSLCertVerificationError`, that's why.
- **Gemini call runs inline, not threaded**: `asyncio.to_thread` on Windows
  hung indefinitely — the cert-trust patch's Windows cert-store lookup isn't
  thread-safe here. So each diagram call blocks the event loop for ~2-5s.
  Fine for one runner; would need fixing for multiple concurrent users.
- **20s extraction interval**: a conservative guess, not a measured limit.
  Free-tier Gemini rate limits online are inconsistent/contradictory and I
  never actually triggered a real 429 to confirm the true cap for
  `gemini-3.6-flash` specifically. If it feels sluggish and you're not
  hitting errors, try lowering `EXTRACTION_INTERVAL_SECONDS` in
  `backend/main.py`. If you start seeing `error` status messages, that's
  probably rate-limiting — the app backs off automatically for ~2min after
  an error either way.
- Model used: `gemini-3.6-flash` (Google's `gemini-2.5-flash` was retired;
  code will need updating again if this one also gets sunset).

## Sponsors used (RUN/HACK, London, Aug 29 2026)
- **Google Gemini** — the actual LLM in use (found a working key; this is
  what powers the diagram extraction)
- ElevenLabs / Tavily — planned but no working API key was found anywhere on
  this machine; not wired in. Browser's built-in Web Speech API substitutes
  for transcription (free, zero-key).
- ⚠️ RUN/HACK's official sponsor list wasn't published as of this session —
  ElevenLabs/Tavily were guesses based on the hackathon name pattern
  ("11 Labs", "2 Valley"), not confirmed sponsors. Worth double-checking
  closer to the event.

## Architecture
```
frontend/index.html   Browser: mic capture (Web Speech API) or manual text
                       box -> WebSocket -> renders Mermaid flowchart
backend/main.py        FastAPI + WebSocket: buffers transcript, runs
                       extraction on a timer (or on-demand via force)
backend/services/
  diagram.py           Gemini call: transcript -> {nodes, edges} JSON
  transcribe.py         (unused currently - ElevenLabs STT, no key)
  enrich.py              (unused currently - Tavily search, no key)
```
