# 🎬 Lectra MV

**[lectra-mv.mp4](lectra-mv.mp4)**: a 96-second promo video (1080p, 30 fps).

No video-generation model was used. Every frame is drawn by code on an HTML
canvas, and the soundtrack is synthesized from scratch (no samples). The
boxes, arrows, colours and examples come straight from the app: the design
tokens in `frontend/styles.css`, the diagram kinds and simple-English rules in
`backend/services/diagram.py`, and the checks listed in the main README.

| Time | Scene |
|---|---|
| 0:00 | The problem: a fast lecture in a second language |
| 0:08 | Title |
| 0:14 | 01 Listen: mic → FastAPI relay → ElevenLabs Scribe → live transcript |
| 0:24 | 02 The live map: Gemini grows the map every ~20 s, or on ⚡ |
| 0:36 | 03 Four shapes: process, timeline, concept, comparison |
| 0:48 | 04 Simple English: every arrow is a sentence, small talk is skipped |
| 0:56 | 05 Quiz built from the map's own arrows |
| 1:06 | 06 Paste a transcript: 6 paragraphs → 6 topics, 22 boxes |
| 1:14 | 07 Under the hood: Browser, FastAPI, Scribe, Gemini, SQLite, topics.py |
| 1:22 | 08 Verified: 45 + 26 + 22 + 10 checks |
| 1:28 | Finale |

## Rebuild it

`source/` holds everything:

- `mv.js`: the animation; `renderFrame(t)` draws any moment of the video
- `music.js`: the soundtrack (120 BPM, A minor), written as a WAV file
- `render.js`: steps through the frames in headless Chrome and muxes them with ffmpeg

```powershell
cd demo\source
npm install puppeteer-core@23.11.1
node music.js music.wav
node render.js video ..\lectra-mv.mp4
```

Needs Node, ffmpeg on PATH, and Chrome (set `CHROME` if it is not in the
default Windows location). After `node music.js music.wav`, opening `mv.html`
plays the video live in the browser.
