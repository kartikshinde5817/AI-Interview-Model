'use strict';

const $ = (s) => document.querySelector(s);
const TOKEN = location.pathname.split('/').filter(Boolean).pop();
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mmss = (s) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.max(0, s) % 60).padStart(2, '0')}`;

const api = async (path, body) => {
  const res = await fetch(`/api/interview/${TOKEN}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
};

const MIC_TEST_SENTENCES = [
  'The quick fox jumped over the lazy dog near the riverbank.',
  'Clear communication is one of the most valuable skills in any team.',
  'Please schedule the review meeting for Tuesday afternoon.',
  'Good preparation makes a difficult interview much easier to handle.',
  'Technology keeps changing the way people work together.',
];

const S = {
  plan: null, question: null, stream: null, recorder: null,
  slot1Left: 0, slot1Time: 1200, inSlot1: true, qLeft: 0, tick: null, armed: false, ended: false,
  qStarted: 0, recBytes: 0, listening: false, recog: null, recogGen: 0, transcript: '',
  verifyStream: null, verifyShot: null, faceTimer: null, voiceTimer: null, deviceTimer: null,
  strikes: { device: 0, voice: 0 }, lastStrikeAt: { device: 0, voice: 0 },
  gameSeq: [], gamePick: [], gamePlaying: false,
};

const show = (id) => {
  ['gate', 'guide', 'exam', 'end'].forEach((s) => $('#' + s).classList.toggle('hide', s !== id));
};

/* ------------------------------------------------------------------ */
/* sign in                                                             */
/* ------------------------------------------------------------------ */

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#loginErr');
  err.classList.add('hide');
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'candidate', token: TOKEN, username: $('#u').value, password: $('#p').value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    boot();
  } catch (e2) {
    err.textContent = e2.message; err.classList.remove('hide');
  }
});

async function boot() {
  let st;
  try {
    st = await api('/state');
  } catch (_) {
    return show('gate');
  }
  S.plan = st.plan;
  S.slot1Left = st.slot1RemainingSec;
  S.slot1Time = st.slot1TimeSec;
  S.inSlot1 = st.inSlot1;

  if (st.status === 'completed') {
    finished('Interview submitted', 'Scoring your interview…', '…');
    return pollResult('You can close this window.');
  }
  if (st.status === 'terminated') {
    return finished('Result: Fail', 'This interview was ended because the window rules were broken, so it is recorded as a fail. Contact the hiring team if you believe this was a mistake.', '×');
  }

  if (st.status === 'in_progress') {
    // Re-entry after a reload counts as leaving the window under strict proctoring.
    if (S.plan.strict) {
      const r = await api('/violation', { type: 'reload_or_reentry', detail: 'The interview page was reloaded or reopened.' });
      if (r.terminated) return finished('Result: Fail', 'The interview page was reloaded, which is not permitted once the interview has started, so this attempt is recorded as a fail.', '×');
    }
  }

  fillGuidelines(st);
  show('guide');
}

/* ------------------------------------------------------------------ */
/* guidelines                                                          */
/* ------------------------------------------------------------------ */

function fillGuidelines(st) {
  const p = st.plan;
  const m = p.mix;
  $('#greet').textContent = `Welcome, ${st.name}`;
  $('#roleLine').textContent = `You are interviewing for ${st.role}. Read every point below — the rules are enforced automatically.`;
  $('#totalMinTxt').textContent = `${Math.round(st.slot1TimeSec / 60)}-minute`;
  $('#s1Txt').textContent = p.slot1;
  $('#s2Txt').textContent = p.slot2;
  $('#mixTxt').textContent = `${m.math} quantitative, ${m.grammar} English grammar and ${m.logic} logical reasoning`;
  $('#planGrid').innerHTML = [
    ['Slot 1 · Interview', `${p.slot1} questions`, `${Math.round(st.slot1TimeSec / 60)}-minute clock, up to ${Math.round(p.qTimeInterview / 60)} min each, asked and answered by AI voice`],
    ['Slot 2 · Reasoning', `${p.slot2} questions`, `${p.qTimeReasoning}s each, multiple choice, text only`],
    ['Verification', 'ID photo + mic check', 'Required before Slot 1 begins'],
    ['Proctoring', 'Camera and mic on', 'Full screen, single window, recorded'],
  ].map(([t, v, d]) => `<div class="plan-cell"><div class="t">${t}</div><div class="v">${esc(v)}</div><div class="d">${esc(d)}</div></div>`).join('');

  const instructions = `Welcome, ${st.name}. You are interviewing for ${st.role}. `
    + `The interview has two slots. Slot one has ${p.slot1} spoken questions, asked by an A I voice, on a ${Math.round(st.slot1TimeSec / 60)} minute clock. `
    + `Slot two has ${p.slot2} multiple choice questions and is fully text based. `
    + `Your camera and microphone must stay on the whole time, and the session is recorded. `
    + `Leaving full screen, switching windows, or opening another application ends the interview immediately. `
    + `Before slot one begins, you will be asked to verify your identity with a photo of yourself holding your I D card, and to read a sentence aloud to test your microphone. `
    + `You can clear and re-record a spoken answer before moving on, and you can submit the interview early at any time using the submit button, with a confirmation step. `
    + `Please connect your camera and microphone to continue.`;
  $('#replayInstr').onclick = () => speak(instructions);
  speak(instructions);
}

$('#deviceBtn').addEventListener('click', setupDevices);

async function setupDevices() {
  const err = $('#guideErr');
  err.classList.add('hide');
  try {
    S.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      audio: { echoCancellation: true, noiseSuppression: true },
    });
  } catch (e) {
    err.textContent = 'The camera and microphone could not be accessed. Allow access in your browser, then press connect again. The interview cannot start without them.';
    err.classList.remove('hide');
    return;
  }
  $('#preview').srcObject = S.stream;
  $('#dotCam').className = 'dot ok'; $('#camTxt').textContent = 'Camera connected';
  $('#dotMic').className = 'dot ok'; $('#micTxt').textContent = 'Microphone connected';
  meterAudio(S.stream);

  try {
    buildRecorder();
    $('#dotRec').className = 'dot ok'; $('#recTxt').textContent = 'Recorder ready';
    $('#deviceBtn').textContent = 'Reconnect devices';
    beginVerification();
  } catch (e) {
    $('#dotRec').className = 'dot bad'; $('#recTxt').textContent = 'This browser cannot record the session. Use Chrome or Edge on a laptop or desktop.';
  }
}

function meterAudio(stream) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    const buf = new Uint8Array(an.frequencyBinCount);
    const loop = () => {
      an.getByteTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
      const el = $('#micLevel');
      if (el) el.style.width = `${Math.min(100, (peak / 60) * 100)}%`;
      requestAnimationFrame(loop);
    };
    loop();
  } catch (_) { /* metering is cosmetic */ }
}

function buildRecorder() {
  const types = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm'];
  const mimeType = types.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t));
  if (!mimeType) throw new Error('unsupported');
  S.recorder = new MediaRecorder(S.stream, { mimeType, videoBitsPerSecond: 500000, audioBitsPerSecond: 64000 });
  S.recorder.ondataavailable = async (e) => {
    if (!e.data || !e.data.size) return;
    try {
      const res = await fetch(`/api/interview/${TOKEN}/recording`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/octet-stream' },
        body: e.data,
      });
      const d = await res.json();
      if (d.bytes) {
        S.recBytes = d.bytes;
        const el = $('#recSize');
        if (el) el.textContent = `${(d.bytes / 1048576).toFixed(1)} MB`;
      }
    } catch (_) { /* keep recording even if one chunk fails */ }
  };
}

/* ------------------------------------------------------------------ */
/* identity verification + mic test                                    */
/* ------------------------------------------------------------------ */

function beginVerification() {
  $('#deviceBtn').closest('.qfoot').classList.add('hide');
  $('#verifyPanel').classList.remove('hide');
  $('#verifyVideo').srcObject = S.stream;
  speak('Please hold your I D card next to your face so both are clearly visible, then press capture verification photo.');
}

$('#captureBtn').addEventListener('click', async () => {
  const err = $('#verifyErr');
  err.classList.add('hide');
  const video = $('#verifyVideo');
  const canvas = $('#shotCanvas');
  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 480;
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.88));
  if (!blob) { err.textContent = 'Could not capture a photo. Try again.'; err.classList.remove('hide'); return; }
  $('#captureBtn').disabled = true;
  $('#captureBtn').textContent = 'Uploading…';
  try {
    await fetch(`/api/interview/${TOKEN}/verification`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/octet-stream' },
      body: blob,
    });
    S.verifyShot = URL.createObjectURL(blob);
    $('#shotPreview').src = S.verifyShot;
    $('#shotPreview').classList.remove('hide');
    $('#verifyVideo').classList.add('hide');
    $('#captureBtn').classList.add('hide');
    $('#retakeBtn').classList.remove('hide');
    beginMicTest();
  } catch (_) {
    err.textContent = 'The photo could not be uploaded. Check your connection and try again.';
    err.classList.remove('hide');
  } finally {
    $('#captureBtn').disabled = false;
    $('#captureBtn').textContent = 'Capture verification photo';
  }
});

$('#retakeBtn').addEventListener('click', () => {
  $('#shotPreview').classList.add('hide');
  $('#verifyVideo').classList.remove('hide');
  $('#captureBtn').classList.remove('hide');
  $('#retakeBtn').classList.add('hide');
  $('#micTestPanel').classList.add('hide');
  $('#readyPanel').classList.add('hide');
});

function beginMicTest() {
  $('#micTestPanel').classList.remove('hide');
  const sentence = MIC_TEST_SENTENCES[Math.floor(Math.random() * MIC_TEST_SENTENCES.length)];
  $('#micSentence').textContent = sentence;
  $('#micTranscript').textContent = '';
  $('#micTestContinue').disabled = true;
  speak('Now please read the sentence on the screen aloud, so we can check your microphone.', () => micTestListen());
}

function micTestListen() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    $('#micTestWarn').classList.remove('hide');
    $('#micTestNote').textContent = 'Voice capture unavailable in this browser.';
    $('#micTestContinue').disabled = false;
    return;
  }
  let heard = '';
  const recog = new SR();
  recog.continuous = true;
  recog.interimResults = true;
  recog.lang = navigator.language || 'en-IN';
  recog.onresult = (e) => {
    let finalChunk = '', interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) finalChunk += e.results[i][0].transcript;
      else interim += e.results[i][0].transcript;
    }
    if (finalChunk) heard = (heard ? heard.trim() + ' ' : '') + finalChunk.trim();
    $('#micTranscript').textContent = heard + (interim ? ' ' + interim : '');
    if ((heard + interim).trim().split(/\s+/).length >= 3) {
      $('#micTestNote').textContent = 'Microphone check passed.';
      $('#micTestContinue').disabled = false;
    }
  };
  recog.onend = () => {};
  try { recog.start(); } catch (_) {}
  S.micTestRecog = recog;
  // Don't force the candidate to wait forever if recognition stalls.
  setTimeout(() => { $('#micTestContinue').disabled = false; }, 12000);
}

$('#micTestContinue').addEventListener('click', () => {
  if (S.micTestRecog) { try { S.micTestRecog.stop(); } catch (_) {} }
  $('#micTestPanel').classList.add('hide');
  $('#readyPanel').classList.remove('hide');
  speak('Verification complete. Press start interview when you are ready.');
});

/* ------------------------------------------------------------------ */
/* start                                                               */
/* ------------------------------------------------------------------ */

$('#startBtn').addEventListener('click', async () => {
  $('#startBtn').disabled = true;
  $('#startBtn').textContent = 'Preparing your questions…';
  try {
    const res = await api('/start', {});
    S.slot1Left = res.slot1RemainingSec;
    S.inSlot1 = res.inSlot1;
    show('exam');
    $('#hudCam').srcObject = S.stream;
    try { await document.documentElement.requestFullscreen(); } catch (_) { /* user may block it */ }
    S.recorder.start(8000);
    setTimeout(() => { S.armed = true; }, 2000);   // ignore focus noise from the fullscreen switch
    renderQuestion(res.question, res.progress);
    startClock();
    startProctorWatch();
  } catch (e) {
    $('#guideErr').textContent = e.message;
    $('#guideErr').classList.remove('hide');
    $('#startBtn').disabled = false;
    $('#startBtn').textContent = 'Start interview';
  }
});

/* ------------------------------------------------------------------ */
/* proctoring                                                          */
/* ------------------------------------------------------------------ */

async function flag(type, detail) {
  if (!S.armed || S.ended) return;
  S.armed = false;                       // one report per event burst
  try {
    const r = await api('/violation', { type, detail });
    if (r.terminated) {
      finished('Result: Fail', 'You left the interview window, so the interview was ended and is recorded as a fail. Contact the hiring team if you believe this was a mistake.', '×');
    } else {
      S.armed = true;
    }
  } catch (_) { S.armed = true; }
}

function reportAlert(type, detail) {
  const now = Date.now();
  if (now - S.lastAlertAt < 20000) return;   // rate-limit so one real event doesn't spam the log
  S.lastAlertAt = now;
  api('/alert', { type, detail }).catch(() => {});
}

let warnHideTimer = null;
function showTopWarning(msg) {
  const el = $('#topWarn');
  el.textContent = msg;
  el.classList.remove('hide');
  clearTimeout(warnHideTimer);
  warnHideTimer = setTimeout(() => el.classList.add('hide'), 6000);
}

function captureSnapshot() {
  return new Promise((resolve) => {
    try {
      const video = $('#hudCam');
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth || 640;
      canvas.height = video.videoHeight || 480;
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.8);
    } catch (_) { resolve(null); }
  });
}

function uploadEvidence(kind, blob) {
  if (!blob) return;
  fetch(`/api/interview/${TOKEN}/evidence?type=${encodeURIComponent(kind)}`, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/octet-stream' },
    body: blob,
  }).catch(() => {});
}

// Three strikes for the same kind of proctoring issue end the interview. Each
// strike shows an on-screen warning and (for device sightings) files a photo
// as evidence; the first two are logged only, the third actually ends things.
function warnStrike(kind, message, evidenceBlob) {
  const now = Date.now();
  if (now - (S.lastStrikeAt[kind] || 0) < 8000) return;   // debounce a continuously-visible issue
  S.lastStrikeAt[kind] = now;
  S.strikes[kind] = (S.strikes[kind] || 0) + 1;
  const n = S.strikes[kind];
  showTopWarning(`⚠ ${message} (Warning ${n} of 3)`);
  if (evidenceBlob) uploadEvidence(kind, evidenceBlob);
  if (n >= 3) {
    api('/violation', { type: `${kind}_repeated`, detail: `${message} — third warning, ending the interview.` })
      .then((r) => {
        if (r.terminated) {
          finished('Result: Fail', `The interview was ended after repeated ${kind === 'device' ? 'electronic device' : 'extra voice'} warnings. This attempt is recorded as a fail.`, '×');
        }
      }).catch(() => {});
  } else {
    api('/alert', { type: kind, detail: message }).catch(() => {});
  }
}

function startProctorWatch() {
  if ('FaceDetector' in window) {
    let detector;
    try { detector = new FaceDetector({ fastMode: true, maxDetectedFaces: 5 }); } catch (_) { detector = null; }
    if (detector) {
      let strikes = 0;
      S.faceTimer = setInterval(async () => {
        if (S.ended) return;
        try {
          const faces = await detector.detect($('#hudCam'));
          if (faces.length > 1) {
            strikes++;
            if (strikes >= 2) {
              reportAlert('multiple_faces', `${faces.length} faces were detected in the camera frame at the same time.`);
              showTopWarning('⚠ Another person appears to be in frame.');
              captureSnapshot().then((b) => uploadEvidence('multiple_faces', b));
              strikes = 0;
            }
          } else strikes = 0;
        } catch (_) { /* detector can fail transiently, ignore */ }
      }, 6000);
    }
  }
  startVoiceWatch();
  startDeviceWatch();
}

function startVoiceWatch() {
  // Best-effort heuristic only: looks for two separated pitch peaks in the human
  // vocal range at once, as a signal that more than one person may be speaking.
  if (!S.stream) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaStreamSource(S.stream);
    const an = ctx.createAnalyser();
    an.fftSize = 2048;
    src.connect(an);
    const buf = new Uint8Array(an.frequencyBinCount);
    const nyquist = ctx.sampleRate / 2;
    const loBin = Math.max(1, Math.floor((85 / nyquist) * buf.length));
    const hiBin = Math.min(buf.length - 2, Math.ceil((400 / nyquist) * buf.length));
    let ticks = 0;
    S.voiceTimer = setInterval(() => {
      if (S.ended) return;
      an.getByteFrequencyData(buf);
      let peaks = 0, lastPeak = -10;
      for (let i = loBin + 1; i < hiBin; i++) {
        if (buf[i] > 150 && buf[i] > buf[i - 1] && buf[i] > buf[i + 1]) {
          if (i - lastPeak > 4) { peaks++; lastPeak = i; }
        }
      }
      if (peaks >= 2) {
        ticks++;
        if (ticks >= 3) { warnStrike('voice', 'A second voice was heard along with yours.'); ticks = 0; }
      } else {
        ticks = Math.max(0, ticks - 1);
      }
    }, 1500);
  } catch (_) { /* best effort only */ }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function startDeviceWatch() {
  // Best-effort only: relies on a general-purpose object detector loaded from a
  // public CDN. If the candidate is offline or the CDN is blocked, this simply
  // never activates rather than breaking the interview.
  try {
    if (!window.cocoSsd) {
      await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.20.0/dist/tf.min.js');
      await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js');
    }
    const model = await window.cocoSsd.load({ base: 'lite_mobilenet_v2' });
    const DEVICE_CLASSES = new Set(['cell phone', 'laptop', 'remote', 'tv', 'keyboard', 'mouse']);
    S.deviceTimer = setInterval(async () => {
      if (S.ended) return;
      try {
        const preds = await model.detect($('#hudCam'));
        const hit = preds.find((p) => DEVICE_CLASSES.has(p.class) && p.score > 0.6);
        if (hit) {
          const blob = await captureSnapshot();
          warnStrike('device', `A possible ${hit.class} was seen in your camera frame.`, blob);
        }
      } catch (_) { /* detector can fail transiently, ignore */ }
    }, 5000);
  } catch (_) { /* CDN unreachable — device detection stays off */ }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) flag('window_switch', 'The tab was hidden or another window was opened.');
});
window.addEventListener('blur', () => flag('focus_lost', 'The interview window lost focus.'));
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && !S.ended && S.armed) flag('fullscreen_exit', 'Full screen was exited.');
});
window.addEventListener('pagehide', () => {
  if (S.ended || !S.armed) return;
  const blob = new Blob([JSON.stringify({ type: 'page_closed', detail: 'The interview page was closed or reloaded.' })], { type: 'application/json' });
  navigator.sendBeacon(`/api/interview/${TOKEN}/violation`, blob);
});
window.addEventListener('beforeunload', (e) => {
  if (S.ended || !S.armed) return;
  e.preventDefault();
  e.returnValue = 'Leaving now will end your interview. Are you sure you want to exit?';
});
document.addEventListener('contextmenu', (e) => { if (S.armed) e.preventDefault(); });
['copy', 'cut', 'paste'].forEach((ev) => document.addEventListener(ev, (e) => { if (S.armed) e.preventDefault(); }));
document.addEventListener('keydown', (e) => {
  if (!S.armed) return;
  const k = e.key.toLowerCase();
  const combo = (e.ctrlKey || e.metaKey) && ['c', 'v', 'x', 'p', 's', 'u', 'f', 't', 'n', 'w'].includes(k);
  if (combo || e.key === 'F12' || (e.altKey && e.key === 'Tab')) e.preventDefault();
});

/* ------------------------------------------------------------------ */
/* submit interview early                                              */
/* ------------------------------------------------------------------ */

$('#submitEarlyBtn').addEventListener('click', async () => {
  if (S.ended) return;
  // Opening a native dialog blurs the window, which would otherwise trip our
  // own anti-cheating blur detector and end the interview before the
  // candidate can even answer the prompt.
  const wasArmed = S.armed;
  S.armed = false;
  const ok = confirm('Submit the interview now? Any unanswered questions will be left blank, and you cannot change your answers after this. Continue?');
  if (!ok) {
    // The blur/focus noise from opening and closing the dialog arrives just after
    // this handler returns — wait it out before re-arming the proctoring checks.
    setTimeout(() => { S.armed = wasArmed; }, 1500);
    return;
  }
  clearInterval(S.tick);
  try { await api('/finish', {}); } catch (_) {}
  finished('Interview submitted', 'Scoring your interview…', '…');
  pollResult('You submitted early — you can close this window.');
});

/* ------------------------------------------------------------------ */
/* question flow                                                       */
/* ------------------------------------------------------------------ */

function renderQuestion(q, progress) {
  S.question = q;
  S.qLeft = q.timeLimit;
  S.qStarted = Date.now();
  S.inSlot1 = q.slot === 1;
  $('#clockCol').classList.toggle('hide', !S.inSlot1);
  stopListening();

  const overall = (progress.slot1.done + progress.slot2.done) + 1;
  $('#slotLabel').textContent = q.slot === 1 ? 'Slot 1 · Interview' : 'Slot 2 · Reasoning';
  $('#slotProgress').textContent = q.slot === 1
    ? `${progress.slot1.done + 1} / ${progress.slot1.total}`
    : `${progress.slot2.done + 1} / ${progress.slot2.total}`;
  $('#qNum').textContent = `Question ${overall} of ${progress.total}${q.slot === 2 ? ` · ${q.category}` : ''}`;
  $('#qText').textContent = q.text;

  $('#mcqArea').classList.add('hide');
  $('#openArea').classList.add('hide');
  $('#gameArea').classList.add('hide');

  if (q.type === 'open') {
    $('#openArea').classList.remove('hide');
    S.transcript = '';
    $('#liveTranscript').textContent = '';
    // The "Listening" state must only appear once the AI has actually finished
    // asking the question — not while it's still talking.
    $('#dotListen').className = 'dot';
    $('#listenTxt').textContent = 'AI is asking the question…';
    $('#micWarn').classList.add('hide');
    speak(q.text, () => { if (S.question === q) startListening(); });
  } else if (q.type === 'game') {
    $('#gameArea').classList.remove('hide');
    setupGame(q);
  } else {
    $('#mcqArea').classList.remove('hide');
    $('#opts').innerHTML = q.options.map((o, i) => `
      <label class="opt" data-i="${i}">
        <input type="radio" name="opt" value="${i}">
        <span class="opt-k">${'ABCD'[i]}</span><span>${esc(o)}</span>
      </label>`).join('');
    $('#opts').querySelectorAll('.opt').forEach((el) => el.addEventListener('click', () => {
      $('#opts').querySelectorAll('.opt').forEach((x) => x.classList.remove('on'));
      el.classList.add('on');
    }));
    // Slot 2 is fully text-based: no AI voice here.
  }
  paintQTimer();
}

/* ------------------------------------------------------------------ */
/* slot 2 memory-tile mini-game                                        */
/* ------------------------------------------------------------------ */

function setupGame(q) {
  S.gameSeq = q.sequence;
  S.gamePick = [];
  $('#nextGame').disabled = true;
  $('#gameNote').textContent = 'Watch the tiles light up in order…';
  const tilesEl = $('#tiles');
  tilesEl.innerHTML = '';
  for (let i = 0; i < q.tiles; i++) {
    const t = document.createElement('div');
    t.className = 'tile';
    t.dataset.i = String(i);
    t.addEventListener('click', () => onTileClick(i, q));
    tilesEl.appendChild(t);
  }
  playSequence(q);
}

async function playSequence(q) {
  S.gamePlaying = true;
  await new Promise((r) => setTimeout(r, 500));
  for (const i of q.sequence) {
    if (S.question !== q) return;   // candidate already moved past this question
    const tile = $(`.tile[data-i="${i}"]`);
    if (tile) tile.classList.add('lit');
    await new Promise((r) => setTimeout(r, 500));
    if (tile) tile.classList.remove('lit');
    await new Promise((r) => setTimeout(r, 200));
  }
  if (S.question !== q) return;
  S.gamePlaying = false;
  $('#gameNote').textContent = 'Now repeat the sequence by clicking the tiles in the same order.';
}

function onTileClick(i, q) {
  if (S.gamePlaying || S.question !== q) return;
  S.gamePick.push(i);
  const tile = $(`.tile[data-i="${i}"]`);
  if (tile) { tile.classList.add('picked'); setTimeout(() => tile.classList.remove('picked'), 250); }
  $('#gameNote').textContent = `Picked ${S.gamePick.length} of ${S.gameSeq.length}.`;
  if (S.gamePick.length >= S.gameSeq.length) $('#nextGame').disabled = false;
}

$('#clearGame').addEventListener('click', () => {
  if (S.gamePlaying) return;
  S.gamePick = [];
  $('#nextGame').disabled = true;
  $('#gameNote').textContent = 'Cleared. Repeat the sequence by clicking the tiles in the same order.';
});
$('#nextGame').addEventListener('click', () => submit(false));

$('#nextOpen').addEventListener('click', () => submit(false));
$('#clearOpen').addEventListener('click', () => {
  S.transcript = '';
  $('#liveTranscript').textContent = '';
  if (!S.listening) startListening();
});
$('#nextMcq').addEventListener('click', () => {
  const sel = $('#opts').querySelector('input:checked');
  if (!sel) { $('#nextMcq').textContent = 'Pick an option first'; setTimeout(() => ($('#nextMcq').textContent = 'Next question'), 1500); return; }
  submit(false);
});

let submitting = false;
async function submit(auto) {
  if (submitting || S.ended || !S.question) return;
  submitting = true;
  const q = S.question;
  const btn = q.type === 'open' ? $('#nextOpen') : q.type === 'game' ? $('#nextGame') : $('#nextMcq');
  btn.disabled = true;
  const sel = q.type === 'mcq' ? $('#opts').querySelector('input:checked') : null;
  if (q.type === 'open') stopListening();
  const payload = {
    questionId: q.id,
    text: q.type === 'open' ? S.transcript.trim() : null,
    choice: sel ? Number(sel.value) : null,
    sequence: q.type === 'game' ? S.gamePick : null,
    timeSpentSec: Math.round((Date.now() - S.qStarted) / 1000),
    skipped: auto && (q.type === 'open' ? !S.transcript.trim() : q.type === 'game' ? S.gamePick.length === 0 : !sel),
  };
  try {
    const res = await api('/answer', payload);
    if (res.done) {
      finished('Interview submitted', 'Scoring your interview…', '…');
      pollResult('Thank you — you can close this window.');
    } else {
      S.slot1Left = res.slot1RemainingSec;
      S.inSlot1 = res.inSlot1;
      renderQuestion(res.question, res.progress);
    }
  } catch (e) {
    if (/not active|closed/i.test(e.message)) return boot();
  } finally {
    submitting = false;
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* clocks                                                              */
/* ------------------------------------------------------------------ */

function paintQTimer() {
  const pct = S.question ? (S.qLeft / S.question.timeLimit) * 100 : 100;
  $('#qBarFill').style.width = `${Math.max(0, pct)}%`;
  $('#qBar').classList.toggle('low', pct < 25);
  $('#qTimer').textContent = `${mmss(S.qLeft)} left for this question`;
  $('#qTimer').classList.toggle('low', S.qLeft <= 15);
}

function startClock() {
  clearInterval(S.tick);
  S.tick = setInterval(() => {
    if (S.ended) return;
    S.qLeft--;

    if (S.inSlot1) {
      S.slot1Left--;
      $('#clock').textContent = mmss(S.slot1Left);
      $('#clock').classList.toggle('low', S.slot1Left <= 300 && S.slot1Left > 60);
      $('#clock').classList.toggle('critical', S.slot1Left <= 60);
      const pctTotal = (S.slot1Left / Math.max(1, S.slot1Time)) * 100;
      $('#railFill').style.width = `${Math.max(0, Math.min(100, pctTotal))}%`;
      $('#rail').classList.toggle('low', pctTotal < 30);
      $('#rail').classList.toggle('critical', pctTotal < 10);
      if (S.slot1Left <= 0) { endSlot1Timeout(); return; }
    }

    paintQTimer();
    if (S.qLeft <= 0) submit(true);
  }, 1000);
}

async function endSlot1Timeout() {
  if (S.ended) return;
  try {
    const st = await api('/state');
    if (st.status === 'completed') {
      finished('Interview submitted', 'Scoring your interview…', '…');
      return pollResult('You can close this window.');
    }
    S.inSlot1 = st.inSlot1;
    $('#clockCol').classList.toggle('hide', !S.inSlot1);
    if (st.question) renderQuestion(st.question, st.progress);
  } catch (_) { /* try again on the next tick */ }
}

/* ------------------------------------------------------------------ */
/* AI voice: speak the question, capture the spoken answer             */
/* ------------------------------------------------------------------ */

function speak(text, onDone) {
  // Some browsers/OS configurations never fire onend (no voices installed, TTS
  // engine stalls, etc). A duration-based fallback guarantees the flow still
  // advances instead of hanging forever waiting for a callback that never comes.
  let done = false;
  const finish = () => { if (done) return; done = true; if (onDone) onDone(); };
  if (!('speechSynthesis' in window)) { finish(); return; }
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 0.98;
    u.onend = finish;
    u.onerror = finish;
    window.speechSynthesis.speak(u);
    const estMs = Math.min(20000, Math.max(1500, text.trim().split(/\s+/).length * 380));
    setTimeout(finish, estMs);
  } catch (_) { finish(); }
}

function startListening() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    $('#micWarn').classList.remove('hide');
    $('#dotListen').className = 'dot bad';
    $('#listenTxt').textContent = 'Voice capture unavailable';
    return;
  }
  $('#micWarn').classList.add('hide');
  $('#dotListen').className = 'dot ok';
  $('#listenTxt').textContent = 'Listening — speak your answer now';
  // Recognition can deliver a final result asynchronously even after .stop() has
  // been called for the previous question. Each instance is tagged with the
  // generation it belongs to so a late, stale callback can't write into the
  // transcript of a question that has already moved on.
  const gen = ++S.recogGen;
  const questionAtStart = S.question;
  S.recog = new SR();
  S.recog.continuous = true;
  S.recog.interimResults = true;
  S.recog.lang = navigator.language || 'en-IN';
  S.recog.onresult = (e) => {
    if (gen !== S.recogGen || S.question !== questionAtStart) return;
    let finalChunk = '';
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) finalChunk += e.results[i][0].transcript;
      else interim += e.results[i][0].transcript;
    }
    if (finalChunk) S.transcript = (S.transcript ? S.transcript.trim() + ' ' : '') + finalChunk.trim();
    $('#liveTranscript').textContent = S.transcript + (interim ? ' ' + interim : '');
  };
  S.recog.onend = () => { if (gen === S.recogGen && S.listening) { try { S.recog.start(); } catch (_) {} } };
  try { S.recog.start(); S.listening = true; } catch (_) {}
}

function stopListening() {
  S.listening = false;
  S.recogGen++;               // invalidates any in-flight callbacks from the old recognition instance
  if (S.recog) { try { S.recog.stop(); } catch (_) {} }
  try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (_) {}
}

/* ------------------------------------------------------------------ */
/* end                                                                 */
/* ------------------------------------------------------------------ */

function finished(title, body, mark) {
  S.ended = true;
  S.armed = false;
  clearInterval(S.tick);
  clearInterval(S.faceTimer);
  clearInterval(S.voiceTimer);
  clearInterval(S.deviceTimer);
  stopListening();
  try { if (S.recorder && S.recorder.state !== 'inactive') S.recorder.stop(); } catch (_) {}
  setTimeout(() => { try { S.stream && S.stream.getTracks().forEach((t) => t.stop()); } catch (_) {} }, 1200);
  if (document.fullscreenElement) { try { document.exitFullscreen(); } catch (_) {} }
  $('#endMark').textContent = mark;
  $('#endTitle').textContent = title;
  $('#endBody').textContent = body;
  show('end');
}

/* ------------------------------------------------------------------ */
/* pass / fail result                                                  */
/* ------------------------------------------------------------------ */

async function pollResult(closingLine) {
  for (let i = 0; i < 20; i++) {
    try {
      const r = await api('/result');
      if (r.ready) {
        $('#endMark').textContent = r.passed ? '✓' : '×';
        $('#endTitle').textContent = r.passed ? 'Result: Pass' : 'Result: Fail';
        $('#endBody').textContent = r.passed
          ? `You passed the interview with an overall score of ${r.overall}/100. ${closingLine}`
          : `You did not clear the interview${r.overall == null ? '' : ` (overall score ${r.overall}/100)`}. ${closingLine}`;
        return;
      }
    } catch (_) { /* keep trying */ }
    await new Promise((res) => setTimeout(res, 3000));
  }
}

boot();
