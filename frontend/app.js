const genBtn = document.getElementById("genBtn");
const ringProgress = document.getElementById("ringProgress");
const waveArea = document.getElementById("waveArea");
const waveCanvas = document.getElementById("waveCanvas");
const waveCtx = waveCanvas.getContext("2d");
const warnBtn = document.getElementById("warnBtn");
const errorLine = document.getElementById("errorLine");
const micBtn = document.getElementById("micBtn");
const transcriptEl = document.getElementById("transcript");
const transcriptEditEl = document.getElementById("transcriptEdit");
const editTranscriptBtn = document.getElementById("editTranscriptBtn");
const generateFromTextBtn = document.getElementById("generateFromTextBtn");
const cyEl = document.getElementById("cy");
const chartWrap = document.getElementById("chartWrap");
const placeholderEl = document.getElementById("placeholder");
const sourceView = document.getElementById("sourceView");
const diagramTools = document.getElementById("diagramTools");
const diagramHint = document.getElementById("diagramHint");
const tidyBtn = document.getElementById("tidyBtn");
const sourceBtn = document.getElementById("sourceBtn");
const zoomControls = document.getElementById("zoomControls");
const zoomInBtn = document.getElementById("zoomInBtn");
const zoomOutBtn = document.getElementById("zoomOutBtn");
const zoomLabel = document.getElementById("zoomLabel");
const fitBtn = document.getElementById("fitBtn");
const quizBody = document.getElementById("quizBody");
const quizScore = document.getElementById("quizScore");
const timerLabel = document.getElementById("timerLabel");

let ws;
let listening = false;
let reconnectDelay = 1000;
let audioCtx, mediaStream, scriptNode, analyser, waveDataArray;
let waveRafId = null;
let finalLines = [];
let partialLine = "";
let editingTranscript = false;
let sttErrorDetail = null; // last known error detail (STT or diagram-gen); null = no active error

// ---- session timer + countdown ring ----
// Both run off one setInterval that's independent of WebSocket events/state,
// so they keep ticking correctly across a WS reconnect; only the *value* they
// display is nudged by server messages (config on connect, extraction fired).
let recordStartMs = null;
// TODO: the backend already sends this once over the WS as the "config"
// message on connect (see ws.onmessage below) - this is just the fallback
// default until that arrives, per this task's "frontend-only" scope.
let extractionIntervalSeconds = 20;
let ringStartMs = null;
let tickInterval = null;

const RING_R = 20;
const RING_C = 2 * Math.PI * RING_R;
ringProgress.style.strokeDasharray = `${RING_C}`;

function fmtMMSS(totalSeconds) {
  const m = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const s = Math.floor(totalSeconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function setRingProgress(frac, instant) {
  const offset = RING_C * (1 - Math.max(0, Math.min(1, frac)));
  if (instant) {
    // Snap instantly instead of visibly winding backwards over the CSS
    // transition - only used on a hard reset (start / force / extraction result).
    ringProgress.style.transition = "none";
    ringProgress.style.strokeDashoffset = `${offset}`;
    void ringProgress.getBoundingClientRect(); // force reflow before re-enabling the transition
    ringProgress.style.transition = "";
  } else {
    ringProgress.style.strokeDashoffset = `${offset}`;
  }
}
setRingProgress(0, true);

function resetRing() {
  ringStartMs = Date.now();
  setRingProgress(0, true);
}

function startTimerAndRing() {
  recordStartMs = Date.now();
  timerLabel.textContent = "00:00";
  resetRing();
  if (tickInterval) clearInterval(tickInterval);
  tickInterval = setInterval(() => {
    timerLabel.textContent = fmtMMSS((Date.now() - recordStartMs) / 1000);
    if (ringStartMs !== null) {
      // Only updated once/sec here, but the 1s linear CSS transition on
      // stroke-dashoffset turns these steps into a smooth continuous sweep.
      setRingProgress((Date.now() - ringStartMs) / 1000 / extractionIntervalSeconds);
    }
  }, 1000);
}

function stopTimerAndRing() {
  if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
  ringStartMs = null; // timer text and ring position both stay frozen at their last value
}

// ---- error surfacing: a small warning icon at the right end of the
// waveform, shown for STT connect/WS/mic-permission errors as well as
// diagram-generation errors (the old "Diagram: error ..." text). Clicking it
// toggles a one-line detail underneath - same information the old status
// text row exposed, just tucked away until asked for. ----
function showError(detail) {
  sttErrorDetail = detail || "Unknown error";
  warnBtn.style.display = "flex";
}
function clearError() {
  sttErrorDetail = null;
  warnBtn.style.display = "none";
  errorLine.style.display = "none";
}
warnBtn.onclick = () => {
  if (errorLine.style.display === "block") {
    errorLine.style.display = "none";
  } else {
    errorLine.textContent = sttErrorDetail || "Unknown error";
    errorLine.style.display = "block";
  }
};
function updateSttStatus(state, detail) {
  if (state === "error") showError(detail);
  else if (state === "connected") clearError();
  // "connecting"/"disconnected" leave any existing error indicator alone -
  // a reconnect attempt shouldn't silently hide a real error, and isn't one itself.
}

// ---- start / stop ----
// Toggle, never hold-to-talk - lectures run long. The waveform area doubles
// as a bigger "tap to start" target while the mic is off; once recording,
// clicking it does nothing (only the mic button stops it).
async function startListening() {
  if (listening) return;
  listening = true;
  micBtn.classList.add("recording");
  micBtn.title = "Stop listening";
  waveArea.classList.remove("clickable");
  genBtn.disabled = false;
  startTimerAndRing();
  // Reuse a connection that's already open (e.g. from ⚡ on a pasted transcript).
  if (ws && ws.readyState === WebSocket.OPEN && !ws.finishing) ws.send(JSON.stringify({ type: "stt_start" }));
  else if (!ws || ws.finishing || ws.readyState > WebSocket.OPEN) connect();
  try {
    await startMic();
    startWaveLoop();
  } catch (e) {
    listening = false;
    micBtn.classList.remove("recording");
    micBtn.title = "Start listening";
    waveArea.classList.add("clickable");
    genBtn.disabled = true;
    stopTimerAndRing();
    showError("mic: " + e.message);
  }
}

function stopListening() {
  listening = false;
  micBtn.classList.remove("recording");
  micBtn.title = "Start listening";
  waveArea.classList.add("clickable");
  genBtn.disabled = true;
  genBtn.classList.remove("busy");
  stopTimerAndRing();
  stopWaveLoop();
  stopMic();
  if (ws) finishSocket(ws);
}

// Stop doesn't close the socket right away: the backend first commits Scribe's
// last partial and runs one final extraction over it, then sends "stopped"
// (handled in connect()). The timeout is only a fallback if that never arrives.
const STOP_FLUSH_TIMEOUT_MS = 30000;
function finishSocket(sock) {
  sock.finishing = true; // this socket's session is ending; never reuse it
  if (sock.readyState !== WebSocket.OPEN) { sock.close(); return; }
  sock.send(JSON.stringify({ type: "stt_stop" }));
  setTimeout(() => sock.close(), STOP_FLUSH_TIMEOUT_MS);
}

micBtn.onclick = () => { listening ? stopListening() : startListening(); };
waveArea.addEventListener("click", () => { if (!listening) startListening(); });

const FORCE_COOLDOWN_MS = 8000; // don't let mashing this button blow through the API quota
genBtn.onclick = () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "force" }));
  genBtn.classList.add("busy");
  resetRing();
  genBtn.disabled = true;
  setTimeout(() => { if (listening) genBtn.disabled = false; }, FORCE_COOLDOWN_MS);
};

// Messages for a connection that isn't open yet -- e.g. ⚡ on a pasted
// transcript with the mic off: the socket is opened on demand, and they go out
// in order once it is.
let outbox = [];
function sendWhenOpen(msg) {
  if (ws && ws.readyState === WebSocket.OPEN && !ws.finishing) {
    ws.send(JSON.stringify(msg));
    return;
  }
  outbox.push(msg);
  if (!ws || ws.finishing || ws.readyState > WebSocket.OPEN) connect(); // none, ending, or closed
}

// ---- websocket ----
function connect() {
  ws = new WebSocket(`ws://${location.host}/ws/lecture`);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    reconnectDelay = 1000;
    // Carry on the map already on screen (after a reconnect, or Start after Stop).
    if (mapTopics.length) ws.send(JSON.stringify({ type: "resume", topics: mapTopics }));
    if (listening) ws.send(JSON.stringify({ type: "stt_start" }));
    for (const msg of outbox.splice(0)) ws.send(JSON.stringify(msg));
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "config") {
      extractionIntervalSeconds = msg.extraction_interval_seconds || extractionIntervalSeconds;
      if (listening) resetRing();
    } else if (msg.type === "diagram") {
      renderMap(msg.topics, msg.new_ids || [], msg.source_text || "");
      genBtn.classList.remove("busy");
      resetRing(); // an extraction just fired (timed or forced) - restart the wait
    } else if (msg.type === "empty") {
      genBtn.classList.remove("busy");
      resetRing();
      if (!mapTopics.length) placeholderEl.textContent = PLACEHOLDER_TEXT;
    } else if (msg.type === "error") {
      genBtn.classList.remove("busy");
      resetRing();
      if (!mapTopics.length) placeholderEl.textContent = PLACEHOLDER_TEXT;
      showError((msg.stage ? msg.stage + ": " : "") + (msg.detail || "diagram generation error"));
    } else if (msg.type === "stt_status") {
      updateSttStatus(msg.state, msg.detail);
    } else if (msg.type === "transcript_chunk") {
      finalLines.push(msg.text);
      partialLine = "";
      renderTranscript();
    } else if (msg.type === "partial_transcript") {
      partialLine = msg.text;
      renderTranscript();
    } else if (msg.type === "stopped") {
      event.target.close(); // final flush + extraction after Stop are done
    }
  };

  ws.onclose = (event) => {
    // A socket still finishing a previous Stop can close after a new session
    // has started. Only the current socket should trigger a reconnect.
    if (!listening || event.target !== ws) return;
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10000);
  };

  ws.onerror = () => {};
}

function renderTranscript() {
  if (editingTranscript) return; // don't clobber what's being typed in the edit box
  const tail = finalLines.slice(-40).join(" ");
  transcriptEl.innerHTML = tail + (partialLine ? ` <span class="partial">${partialLine}</span>` : "");
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

// ---- transcript editing: the pencil opens an editable copy of the committed
// transcript, to fix mis-heard words or paste in a ready transcript. ✓ saves
// (the backend diagrams anything new at its next update while listening);
// ⚡ saves and builds the map right away, with or without the mic. Boxes
// already on the map stay as they are. ----
const PLACEHOLDER_TEXT = placeholderEl.textContent;

function openTranscriptEditor() {
  editingTranscript = true;
  transcriptEditEl.value = finalLines.join(" ");
  transcriptEl.style.display = "none";
  transcriptEditEl.style.display = "block";
  generateFromTextBtn.style.display = "flex";
  editTranscriptBtn.textContent = "✓";
  editTranscriptBtn.title = "Save the transcript";
  editTranscriptBtn.classList.add("active");
  transcriptEditEl.focus();
}

function closeTranscriptEditor(generate) {
  const corrected = transcriptEditEl.value.trim();
  finalLines = corrected ? [corrected] : [];
  partialLine = "";
  if (generate) {
    sendWhenOpen({ type: "transcript_edit", text: corrected });
    sendWhenOpen({ type: "force" });
    if (!mapTopics.length) placeholderEl.textContent = "Building the map…";
  } else if (ws && ws.readyState === WebSocket.OPEN && !ws.finishing) {
    ws.send(JSON.stringify({ type: "transcript_edit", text: corrected }));
  }
  editingTranscript = false;
  transcriptEl.style.display = "block";
  transcriptEditEl.style.display = "none";
  generateFromTextBtn.style.display = "none";
  editTranscriptBtn.textContent = "✎";
  editTranscriptBtn.title = "Edit or paste the transcript";
  editTranscriptBtn.classList.remove("active");
  renderTranscript();
}

editTranscriptBtn.onclick = () => (editingTranscript ? closeTranscriptEditor(false) : openTranscriptEditor());
generateFromTextBtn.onclick = () => closeTranscriptEditor(true);

// ---- mic capture: getUserMedia -> downsample to 16kHz mono -> Int16 PCM -> binary WS frames ----
// ScriptProcessorNode is deprecated but universally supported and keeps this a
// single file with no separate AudioWorklet module to load.
async function startMic() {
  mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true } });
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioCtx.createMediaStreamSource(mediaStream);
  scriptNode = audioCtx.createScriptProcessor(4096, 1, 1);
  const silence = audioCtx.createGain();
  silence.gain.value = 0; // route through destination without audible playback/echo
  source.connect(scriptNode);
  scriptNode.connect(silence);
  silence.connect(audioCtx.destination);

  // Waveform tap: a second parallel connection off the SAME mic source used
  // for STT capture above - never a second getUserMedia call.
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.75;
  source.connect(analyser);
  waveDataArray = new Uint8Array(analyser.frequencyBinCount);

  scriptNode.onaudioprocess = (e) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const input = e.inputBuffer.getChannelData(0);
    const down = downsample(input, audioCtx.sampleRate, 16000);
    ws.send(floatTo16BitPCM(down).buffer);
  };
}

function stopMic() {
  if (scriptNode) { scriptNode.disconnect(); scriptNode.onaudioprocess = null; scriptNode = null; }
  if (analyser) { analyser.disconnect(); analyser = null; }
  if (audioCtx) { audioCtx.close(); audioCtx = null; }
  if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
  waveDataArray = null;
}

// ---- live waveform: one canvas, one rAF loop, cancelled whenever the mic is
// off. Reflects LOCAL mic input only, via the AnalyserNode tapped above - it
// keeps animating even if the Scribe WebSocket drops; the warning icon (see
// showError/updateSttStatus) is what signals a connection problem, not this. ----
const WAVE_BAR_COUNT = 28;
const WAVE_BAR_GAP = 3;
const WAVE_MIN_LEVEL = 0.12; // floor so "recording but silent" still reads as "on", not a flat line
// Colours come from the design tokens in :root.
const rootStyle = getComputedStyle(document.documentElement);
const cssColor = (name) => rootStyle.getPropertyValue(name).trim();
const WAVE_COLOR_ACTIVE = cssColor("--wave-active");
const WAVE_COLOR_IDLE = cssColor("--wave-idle");

function resizeWaveCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = waveCanvas.getBoundingClientRect();
  waveCanvas.width = Math.max(1, Math.round(rect.width * dpr));
  waveCanvas.height = Math.max(1, Math.round(rect.height * dpr));
  waveCtx.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in CSS-pixel coordinates from here on
}

function fillRoundedBar(x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  waveCtx.beginPath();
  waveCtx.moveTo(x + rr, y);
  waveCtx.arcTo(x + w, y, x + w, y + h, rr);
  waveCtx.arcTo(x + w, y + h, x, y + h, rr);
  waveCtx.arcTo(x, y + h, x, y, rr);
  waveCtx.arcTo(x, y, x + w, y, rr);
  waveCtx.closePath();
  waveCtx.fill();
}

function drawFlatLine(color) {
  const w = waveCanvas.clientWidth, h = waveCanvas.clientHeight;
  waveCtx.clearRect(0, 0, w, h);
  waveCtx.fillStyle = color;
  fillRoundedBar(0, h / 2 - 1, w, 2, 1);
}

function drawBars() {
  const w = waveCanvas.clientWidth, h = waveCanvas.clientHeight;
  waveCtx.clearRect(0, 0, w, h);
  analyser.getByteFrequencyData(waveDataArray);
  const barWidth = (w - (WAVE_BAR_COUNT - 1) * WAVE_BAR_GAP) / WAVE_BAR_COUNT;
  const binsPerBar = Math.max(1, Math.floor(waveDataArray.length / WAVE_BAR_COUNT));
  waveCtx.fillStyle = WAVE_COLOR_ACTIVE;
  for (let i = 0; i < WAVE_BAR_COUNT; i++) {
    let sum = 0;
    for (let j = 0; j < binsPerBar; j++) sum += waveDataArray[i * binsPerBar + j] || 0;
    const level = Math.max(sum / binsPerBar / 255, WAVE_MIN_LEVEL); // floor keeps "silent but recording" visibly "on"
    const barH = Math.max(2, level * h);
    const x = i * (barWidth + WAVE_BAR_GAP);
    fillRoundedBar(x, (h - barH) / 2, barWidth, barH, barWidth / 2);
  }
  waveRafId = requestAnimationFrame(drawBars);
}

function startWaveLoop() {
  resizeWaveCanvas();
  if (waveRafId) cancelAnimationFrame(waveRafId);
  drawBars();
}

function stopWaveLoop() {
  if (waveRafId) { cancelAnimationFrame(waveRafId); waveRafId = null; }
  resizeWaveCanvas();
  drawFlatLine(WAVE_COLOR_IDLE);
}

window.addEventListener("resize", () => {
  resizeWaveCanvas();
  if (!waveRafId) drawFlatLine(WAVE_COLOR_IDLE); // the rAF loop redraws itself; only the idle line needs a manual repaint
  if (cy) cy.resize();
});

resizeWaveCanvas();
drawFlatLine(WAVE_COLOR_IDLE); // initial paint before anything starts

function downsample(buffer, inRate, outRate) {
  if (outRate === inRate) return buffer;
  const ratio = inRate / outRate;
  const newLength = Math.round(buffer.length / ratio);
  const result = new Float32Array(newLength);
  let offsetResult = 0, offsetBuffer = 0;
  while (offsetResult < newLength) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
    let accum = 0, count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) { accum += buffer[i]; count++; }
    result[offsetResult] = count ? accum / count : 0;
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }
  return result;
}

function floatTo16BitPCM(float32Array) {
  const out = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

// ---- lecture map canvas: Cytoscape.js + dagre ----
// The server sends the whole map (topics, each a small flowchart) after every
// update. The canvas only adds what's new, so finished topics -- and boxes the
// user has moved there -- stay put. Each topic is a labelled group (a compound
// node) laid out top to bottom; groups sit side by side, left to right.
const LABEL_FONT_FAMILY = '-apple-system, "Segoe UI", Roboto, sans-serif';
const LABEL_FONT_SIZE = 13;
const LABEL_LINE_HEIGHT = 1.25;
const NODE_TEXT_MAX_WIDTH = 170;
const NODE_PADDING = 14;
const TOPIC_PADDING = 22;
const TOPIC_GAP = 80; // space between topic groups
const FIT_PADDING = 32;
const FIT_MAX_ZOOM = 1.2; // don't blow a 3-box map up to fill the whole canvas
const ZOOM_STEP = 1.25; // + / − buttons
const WHEEL_ZOOM_SPEED = 0.003; // pinch / Ctrl + wheel
const GRID_SIZE = 24;
const MOVE_MS = 350;
const FRESH_MS = 4000; // how long new boxes glow
// How each kind of topic is drawn (the kind comes from Gemini, see
// backend/services/topics.py); the icon shows in the topic's title.
const KINDS = {
  process: { icon: "⚙️", layout: { name: "dagre", rankDir: "TB", nodeSep: 40, rankSep: 55 } },
  timeline: { icon: "⏳", layout: { name: "dagre", rankDir: "LR", nodeSep: 30, rankSep: 55 } },
  comparison: { icon: "⚖️", layout: { name: "dagre", rankDir: "TB", nodeSep: 30, rankSep: 70 } },
  concept: { icon: "💡", layout: null }, // radial, see layoutConcept()
};
const kindOf = (topic) => (topic && KINDS[topic.kind] ? topic.kind : "process");
// A transparent 1px image for topic groups. Without any background image,
// Cytoscape (3.31-3.34) flips a group's :backgrounding state on every draw and
// restyles the group and all its boxes each frame, which froze the canvas
// while scrolling, zooming or dragging (720 restyles per 60 scroll steps -> 0).
const BLANK_IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const measureCtx = document.createElement("canvas").getContext("2d");
measureCtx.font = `600 ${LABEL_FONT_SIZE}px ${LABEL_FONT_FAMILY}`;

// Box size from the measured label (Cytoscape deprecated width/height: "label").
// Wraps at word boundaries the same way the label itself is wrapped.
function nodeSize(label) {
  const space = measureCtx.measureText(" ").width;
  let lines = 1, lineWidth = 0, widest = 0;
  for (const word of label.split(/\s+/).filter(Boolean)) {
    const w = measureCtx.measureText(word).width;
    if (lineWidth > 0 && lineWidth + space + w > NODE_TEXT_MAX_WIDTH) {
      lines++;
      lineWidth = w;
    } else {
      lineWidth += (lineWidth > 0 ? space : 0) + w;
    }
    widest = Math.max(widest, lineWidth);
  }
  return {
    w: Math.min(widest, NODE_TEXT_MAX_WIDTH) + 2 * NODE_PADDING,
    h: lines * LABEL_FONT_SIZE * LABEL_LINE_HEIGHT + 2 * NODE_PADDING,
  };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

let cy = null;
let mapTopics = []; // latest map from the server; sent back on reconnect ("resume")
let lastSourceText = "";
let showingSource = false;
let followView = true; // keep the whole map in view as it grows, until the user moves the view
let programmaticView = 0; // > 0 while we move the viewport ourselves
let fitPending = false; // the map grew while the canvas was hidden behind the source view

function getCy() {
  if (cy) return cy;
  // Cytoscape styles take literal colors, so read them from the page's CSS variables.
  const color = cssColor;
  cy = cytoscape({
    container: cyEl,
    minZoom: 0.2,
    maxZoom: 3,
    boxSelectionEnabled: false,
    style: [
      {
        selector: ".box",
        style: {
          shape: "round-rectangle",
          width: "data(w)",
          height: "data(h)",
          "background-color": color("--node-bg"),
          "border-width": 2,
          "border-color": color("--node-border"),
          label: "data(label)",
          color: color("--node-text"),
          "font-family": LABEL_FONT_FAMILY,
          "font-size": LABEL_FONT_SIZE,
          "font-weight": 600,
          "line-height": LABEL_LINE_HEIGHT,
          "text-wrap": "wrap",
          "text-max-width": NODE_TEXT_MAX_WIDTH,
          "text-valign": "center",
          "text-halign": "center",
          "underlay-color": color("--fresh-glow"),
          "underlay-padding": 8,
          "underlay-shape": "round-rectangle",
          "underlay-opacity": 0,
          "transition-property": "opacity, underlay-opacity",
          "transition-duration": 0.6,
        },
      },
      { selector: ".box.fresh", style: { "underlay-opacity": 0.4 } },
      { selector: ".box.entering", style: { opacity: 0 } },
      { selector: ".box:selected", style: { "border-color": color("--highlight"), "border-width": 3 } },
      {
        selector: ".topic",
        style: {
          shape: "round-rectangle",
          "background-color": color("--topic-bg"),
          "background-image": BLANK_IMAGE, // see BLANK_IMAGE
          "border-width": 1.5,
          "border-color": color("--topic-border"),
          padding: TOPIC_PADDING,
          label: "data(label)",
          color: color("--topic-title"),
          "font-family": LABEL_FONT_FAMILY,
          "font-size": 15,
          "font-weight": 700,
          "text-valign": "top",
          "text-halign": "center",
          "text-margin-y": -6,
        },
      },
      {
        selector: "edge",
        style: {
          width: 2,
          "curve-style": "bezier",
          "line-color": color("--edge"),
          "target-arrow-shape": "triangle",
          "target-arrow-color": color("--edge"),
          label: "data(label)",
          color: color("--edge"),
          "font-family": LABEL_FONT_FAMILY,
          "font-size": 11,
          "text-background-color": color("--topic-bg"),
          "text-background-opacity": 1,
          "text-background-padding": 2,
        },
      },
      { selector: ".box.quiz-hl", style: { "border-color": color("--highlight"), "border-width": 3 } },
      {
        selector: "edge.quiz-hl",
        style: { width: 3, "line-color": color("--highlight"), "target-arrow-color": color("--highlight"), color: color("--highlight") },
      },
    ],
  });
  cy.on("viewport", () => {
    updateGrid();
    if (!programmaticView) followView = false; // the user took over; stop auto-fitting
  });
  updateGrid();
  return cy;
}

// The dot grid (CSS background of #cy) moves and scales with the canvas. Set on
// #chartWrap, not #cy: see the #cy style for why.
function updateGrid() {
  let size = GRID_SIZE * cy.zoom();
  while (size < 12) size *= 2; // keep zoomed-out dots from turning into a haze
  const pan = cy.pan();
  chartWrap.style.setProperty("--grid-size", `${size}px ${size}px`);
  chartWrap.style.setProperty("--grid-pos", `${pan.x}px ${pan.y}px`);
  zoomLabel.textContent = `${Math.round(cy.zoom() * 100)}%`;
}

// Move the viewport without it counting as the user taking over.
function setViewport(target, animate) {
  programmaticView++;
  if (animate) {
    cy.animate(target, { duration: MOVE_MS, easing: "ease-in-out-cubic", complete: () => programmaticView-- });
  } else {
    cy.viewport(target);
    programmaticView--;
  }
}

function fitView(animate) {
  fitPending = false;
  followView = true;
  const eles = cy.elements();
  if (!eles.length) return;
  const bb = eles.boundingBox({ includeLabels: true });
  const w = cy.width(), h = cy.height();
  const zoom = clamp(Math.min((w - 2 * FIT_PADDING) / bb.w, (h - 2 * FIT_PADDING) / bb.h), cy.minZoom(), FIT_MAX_ZOOM);
  setViewport({ zoom, pan: { x: (w - zoom * (bb.x1 + bb.x2)) / 2, y: (h - zoom * (bb.y1 + bb.y2)) / 2 } }, animate);
}

// A concept map as a radial tree: the most connected box in the middle, its
// branches on a ring around it, their branches on the next ring out -- each in
// the same direction as its parent, so arrows stay short and don't cross.
function layoutConcept(kids) {
  const center = kids.max((n) => n.degree(false)).ele;
  const children = new Map([[center.id(), []]]);
  const depth = new Map([[center.id(), 0]]);
  kids.union(kids.connectedEdges()).bfs({
    roots: center,
    directed: false,
    visit: (v, e, u, i, d) => {
      if (u) children.get(u.id()).push(v);
      if (!children.has(v.id())) children.set(v.id(), []);
      depth.set(v.id(), d);
    },
  });
  kids.forEach((n) => { // boxes with no arrow to the rest: extra branches of the middle
    if (depth.has(n.id())) return;
    children.get(center.id()).push(n);
    children.set(n.id(), []);
    depth.set(n.id(), 1);
  });
  const leaves = (n) => children.get(n.id()).reduce((sum, c) => sum + leaves(c), 0) || 1;
  const ring = Math.max(170, (leaves(center) * 90) / (2 * Math.PI)); // room for every outer box
  // Each box gets a slice of the circle in proportion to how many outer boxes hang off it.
  const place = (n, from, to) => {
    const d = depth.get(n.id()), angle = (from + to) / 2;
    n.position({ x: Math.cos(angle) * ring * d, y: Math.sin(angle) * ring * d });
    let start = from;
    for (const c of children.get(n.id())) {
      const span = ((to - from) * leaves(c)) / leaves(n);
      place(c, start, start + span);
      start += span;
    }
  };
  place(center, -Math.PI / 2, (3 * Math.PI) / 2);
}

// Lay out the given topics' boxes in their kind's shape and put each group
// just right of the one before it; other topics don't move. `starts` (box id ->
// position) makes boxes glide there from where they were instead of jumping.
function layoutTopics(topicIds, starts) {
  for (const id of topicIds) {
    const kids = cy.getElementById(id).children();
    if (kids.empty()) continue;
    const i = mapTopics.findIndex((t) => t.id === id);
    const kind = kindOf(mapTopics[i]);
    if (kind === "concept") layoutConcept(kids);
    else kids.union(kids.connectedEdges()).layout({ ...KINDS[kind].layout, fit: false, animate: false }).run();
    const prev = i > 0 ? cy.getElementById(mapTopics[i - 1].id) : null;
    const left = prev && prev.nonempty() ? prev.boundingBox({ includeLabels: true }).x2 + TOPIC_GAP : 0;
    const top = prev && prev.nonempty() ? prev.children().boundingBox().y1 : 0; // groups share a top line
    const bb = kids.boundingBox();
    kids.shift({ x: left + TOPIC_PADDING - bb.x1, y: top - bb.y1 });
  }
  if (followView) {
    if (showingSource) fitPending = true;
    else fitView(!!starts);
  }
  if (!starts) return;
  for (const [id, from] of starts) {
    const n = cy.getElementById(id);
    const to = { ...n.position() };
    if (Math.abs(from.x - to.x) < 0.5 && Math.abs(from.y - to.y) < 0.5) continue;
    n.position(from);
    n.animate({ position: to }, { duration: MOVE_MS, easing: "ease-in-out-cubic" });
  }
}

// New boxes start on a box they connect to (or under their topic), so they
// grow out of the map instead of flying in from a corner.
function startPositions(added, starts) {
  const fresh = new Set(added.map((n) => n.id()));
  for (const n of added) {
    const anchor = n.neighborhood(".box").filter((x) => !fresh.has(x.id()));
    const siblings = n.parent().children().filter((x) => !fresh.has(x.id()));
    if (anchor.nonempty()) {
      starts.set(n.id(), { ...anchor[0].position() });
    } else if (siblings.nonempty()) {
      const bb = siblings.boundingBox();
      starts.set(n.id(), { x: (bb.x1 + bb.x2) / 2, y: bb.y2 + 60 });
    }
  }
}

function renderMap(topics, newIds, sourceText) {
  if (!topics || !topics.length) return;
  mapTopics = topics;
  lastSourceText = sourceText || lastSourceText;
  if (showingSource) sourceView.textContent = lastSourceText; // keep an open source view fresh

  placeholderEl.style.display = "none";
  chartWrap.classList.add("has-map");
  diagramTools.style.display = "";
  zoomControls.style.display = showingSource ? "none" : "";
  diagramHint.style.display = showingSource ? "none" : "";
  // Visible before Cytoscape measures it; only written when it changes, since
  // any write to its container makes Cytoscape re-measure the whole graph.
  if (!showingSource && cyEl.style.display !== "block") cyEl.style.display = "block";
  getCy();

  // A map that doesn't match the canvas (the server restarted without the
  // resume) replaces it; otherwise only what's new gets added.
  const clash = topics.some((t) => t.nodes.some((n) => {
    const el = cy.getElementById(n.id);
    return el.nonempty() && el.data("text") !== n.label;
  }));
  if (clash) cy.elements().remove();

  const starts = new Map();
  cy.nodes(".box").forEach((n) => starts.set(n.id(), { ...n.position() }));
  const changed = new Set();
  const added = [];
  cy.batch(() => {
    topics.forEach((t, i) => {
      const title = `${KINDS[kindOf(t)].icon} ${i + 1}. ${t.title}`;
      const group = cy.getElementById(t.id);
      if (group.empty()) {
        cy.add({ group: "nodes", data: { id: t.id, label: title }, classes: "topic", selectable: false });
        changed.add(t.id);
      } else if (group.data("label") !== title) {
        group.data("label", title);
      }
      for (const n of t.nodes) {
        if (cy.getElementById(n.id).nonempty()) continue;
        const label = n.emoji ? `${n.emoji} ${n.label}` : n.label;
        added.push(cy.add({
          group: "nodes",
          data: { id: n.id, parent: t.id, text: n.label, label, ...nodeSize(label) },
          classes: "box entering fresh",
        }));
        changed.add(t.id);
      }
      for (const e of t.edges) {
        const id = `e:${e.from}:${e.to}`;
        if (cy.getElementById(id).nonempty() || cy.getElementById(e.from).empty() || cy.getElementById(e.to).empty()) continue;
        cy.add({ group: "edges", data: { id, source: e.from, target: e.to, label: e.label || "" } });
        changed.add(t.id);
      }
    });
  });
  if (!changed.size) return;

  startPositions(added, starts);
  layoutTopics(topics.map((t) => t.id).filter((id) => changed.has(id)), starts.size ? starts : null);

  // New boxes fade in and glow for a few seconds (see the .entering/.fresh styles).
  const fresh = cy.collection(added);
  setTimeout(() => fresh.removeClass("entering"), 30);
  setTimeout(() => fresh.removeClass("fresh"), FRESH_MS);
  chartWrap.classList.remove("flash");
  void chartWrap.offsetWidth; // restart animation
  chartWrap.classList.add("flash");
  quizMapChanged();
}

// Figma-style navigation: scroll / two-finger swipe moves the canvas; pinch
// (which browsers report as Ctrl + wheel) or Ctrl + scroll zooms around the
// pointer. Handled here in the capture phase, before Cytoscape's own wheel
// zoom -- that turned every small touchpad scroll event into a zoom step.
chartWrap.addEventListener("wheel", (e) => {
  if (!cy || showingSource) return; // the source text scrolls normally
  e.preventDefault();
  e.stopPropagation();
  followView = false;
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? cy.height() : 1;
  let dx = e.deltaX * unit, dy = e.deltaY * unit;
  if (e.ctrlKey || e.metaKey) {
    const r = cyEl.getBoundingClientRect();
    const level = clamp(cy.zoom() * Math.exp(-clamp(dy, -50, 50) * WHEEL_ZOOM_SPEED), cy.minZoom(), cy.maxZoom());
    cy.zoom({ level, renderedPosition: { x: e.clientX - r.left, y: e.clientY - r.top } });
  } else {
    if (e.shiftKey && !dx) { dx = dy; dy = 0; } // Shift + mouse wheel scrolls sideways
    cy.panBy({ x: -dx, y: -dy });
  }
}, { capture: true, passive: false });

function zoomByStep(factor) {
  followView = false;
  const level = clamp(cy.zoom() * factor, cy.minZoom(), cy.maxZoom());
  cy.animate({ zoom: { level, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } } }, { duration: 180 });
}
zoomInBtn.onclick = () => zoomByStep(ZOOM_STEP);
zoomOutBtn.onclick = () => zoomByStep(1 / ZOOM_STEP);
fitBtn.onclick = () => fitView(true);

tidyBtn.onclick = () => {
  const starts = new Map();
  cy.nodes(".box").forEach((n) => starts.set(n.id(), { ...n.position() }));
  followView = true;
  layoutTopics(mapTopics.map((t) => t.id), starts);
};

// ---- trust feature: the exact speech behind the newest boxes, in place of the canvas ----
sourceBtn.onclick = () => {
  showingSource = !showingSource;
  sourceBtn.classList.toggle("active", showingSource);
  sourceView.textContent = lastSourceText || "(no speech recorded yet)";
  sourceView.style.display = showingSource ? "block" : "none";
  cyEl.style.display = showingSource ? "none" : "block";
  zoomControls.style.display = diagramHint.style.display = showingSource ? "none" : "";
  tidyBtn.disabled = showingSource; // it only acts on the (hidden) canvas
  if (!showingSource) {
    cy.resize(); // the window may have changed size while the canvas was hidden
    if (fitPending) fitView(false);
  }
};

// ---- quiz: fill-in-the-blank questions made from the map's own arrows, so
// they cost no extra Gemini call and use the same simple words ----
const quiz = { current: null, asked: new Set(), right: 0, total: 0 };
const boxText = (n) => (n.emoji ? `${n.emoji} ${n.label}` : n.label);

function shuffle(items) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function quizArrows() {
  const out = [];
  for (const t of mapTopics) {
    const byId = new Map(t.nodes.map((n) => [n.id, n]));
    for (const e of t.edges) {
      if (e.label && byId.has(e.from) && byId.has(e.to)) out.push({ edge: e, from: byId.get(e.from), to: byId.get(e.to), topic: t });
    }
  }
  return out;
}

function makeQuestion() {
  const arrows = quizArrows();
  const key = (a) => `${a.edge.from}:${a.edge.to}`;
  let pool = arrows.filter((a) => !quiz.asked.has(key(a)));
  if (!pool.length) {
    quiz.asked.clear(); // every arrow asked once: start over
    pool = arrows;
  }
  for (const a of shuffle(pool)) {
    const blankIsTarget = Math.random() < 0.5;
    const answer = blankIsTarget ? a.to : a.from;
    const shown = blankIsTarget ? a.from : a.to;
    // Wrong options: other boxes, same topic first (the most plausible ones),
    // never one that would also make a true sentence here.
    const taken = new Set([answer.label, shown.label].map((s) => s.toLowerCase()));
    for (const x of arrows) {
      if (x.edge.label !== a.edge.label) continue;
      if (blankIsTarget && x.from.id === shown.id) taken.add(x.to.label.toLowerCase());
      if (!blankIsTarget && x.to.id === shown.id) taken.add(x.from.label.toLowerCase());
    }
    const wrong = [];
    for (const n of [...shuffle(a.topic.nodes), ...shuffle(mapTopics.flatMap((t) => t.nodes))]) {
      if (wrong.length === 3) break;
      if (taken.has(n.label.toLowerCase())) continue;
      taken.add(n.label.toLowerCase());
      wrong.push(n);
    }
    if (!wrong.length) continue;
    quiz.asked.add(key(a));
    return { arrow: a, blankIsTarget, answer, shown, options: shuffle([answer, ...wrong]), choice: null };
  }
  return null;
}

function renderQuiz() {
  quizScore.textContent = quiz.total ? `${quiz.right} / ${quiz.total}` : "";
  const q = quiz.current;
  if (!q) {
    quizBody.replaceChildren(el("p", "quiz-empty", "Questions appear here once the map has a few arrows."));
    return;
  }
  const answered = q.choice !== null;
  const blank = el("span", "blank", answered ? boxText(q.answer) : "?");
  const shown = el("b", "", boxText(q.shown));
  const question = el("p", "quiz-question");
  const verb = ` ${q.arrow.edge.label} `;
  if (q.blankIsTarget) question.append(shown, verb, blank);
  else question.append(blank, verb, shown);

  const options = el("div", "quiz-options");
  for (const n of q.options) {
    const b = el("button", "", boxText(n));
    b.type = "button";
    b.disabled = answered;
    if (answered && n.id === q.answer.id) b.classList.add("right");
    if (answered && n.id === q.choice.id && n.id !== q.answer.id) b.classList.add("wrong");
    b.onclick = () => answerQuiz(n);
    options.append(b);
  }
  const parts = [el("p", "quiz-empty", "Fill the gap:"), question, options];
  if (answered) {
    const right = q.choice.id === q.answer.id;
    const sentence = `${q.arrow.from.label} ${q.arrow.edge.label} ${q.arrow.to.label}.`;
    parts.push(el("p", "quiz-feedback", `${right ? "✅ Right!" : "❌ Not quite."} ${sentence}`));
    const next = el("button", "", "Next question →");
    next.type = "button";
    next.id = "quizNext";
    next.onclick = nextQuestion;
    parts.push(next);
  }
  quizBody.replaceChildren(...parts);
}

function answerQuiz(choice) {
  const q = quiz.current;
  if (!q || q.choice) return;
  q.choice = choice;
  quiz.total++;
  if (choice.id === q.answer.id) quiz.right++;
  renderQuiz();
  highlightArrow(q.arrow);
}

// Show the arrow the question was about on the map, panning to it if needed.
function highlightArrow(a) {
  if (!cy) return;
  cy.elements(".quiz-hl").removeClass("quiz-hl");
  const hl = cy.getElementById(a.from.id)
    .union(cy.getElementById(a.to.id))
    .union(cy.getElementById(`e:${a.edge.from}:${a.edge.to}`));
  hl.addClass("quiz-hl");
  if (showingSource) return;
  const bb = hl.renderedBoundingBox();
  if (bb.x1 < 0 || bb.y1 < 0 || bb.x2 > cy.width() || bb.y2 > cy.height()) {
    followView = false;
    cy.animate({ center: { eles: hl } }, { duration: MOVE_MS });
  }
}

function nextQuestion() {
  if (cy) cy.elements(".quiz-hl").removeClass("quiz-hl");
  quiz.current = makeQuestion();
  renderQuiz();
}

function quizMapChanged() {
  if (!quiz.current) nextQuestion(); // a question in progress stays until answered
}
