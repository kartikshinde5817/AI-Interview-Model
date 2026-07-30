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
  needsAadhaar: false, aadhaarOk: false,
  loudFrames: 0, micTestPassed: false, micGateTimer: null, micTestSR: true,
  micTarget: '', micHeard: '', micRestarts: 0, micSentence: '',
  micRecorder: null, micChunks: [], micUploading: false,
  monitorTimer: null, monitorBusy: false,
  strikes: { device: 0, voice: 0 }, lastStrikeAt: { device: 0, voice: 0 },
  gameSeq: [], gamePick: [], gamePlaying: false, pendingNext: null, isLast: false,
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
  S.needsAadhaar = !!st.needsAadhaar;
  S.aadhaarOk = !!st.aadhaarVerified;
  S.micSentence = st.micSentence || '';

  if (st.status === 'completed') {
    finished('Interview Submitted Successfully', 'Your final responses have been saved. Scoring your interview…', '✓');
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
  $('#greet').textContent = `Welcome, ${st.name}`;
  $('#roleLine').textContent = `You are interviewing for ${st.role}. Read every point below — the rules are enforced automatically.`;
  $('#totalMinTxt').textContent = `${Math.round(st.slot1TimeSec / 60)}-minute`;
  $('#s1Txt').textContent = p.slot1;
  $('#s2Txt').textContent = p.slot2;
  $('#mixTxt').textContent = `${2 * p.nGame} mini-games, ${p.nAnalytical} analytical ability, ${p.nPuzzle} puzzle and ${p.nMath} quantitative aptitude`;
  $('#planGrid').innerHTML = [
    ['Slot 1 · Interview', `${p.slot1} questions`, `${Math.round(st.slot1TimeSec / 60)}-minute clock, up to ${Math.round(p.qTimeInterview / 60)} min each, asked and answered by AI voice`],
    ['Slot 2 · Reasoning', `${p.slot2} questions`, `${p.qTimeReasoning}s each, multiple choice, text only`],
    ['Verification', st.needsAadhaar ? 'Aadhaar + photo + mic' : 'ID photo + mic check', 'Required before Slot 1 begins'],
    ['Proctoring', 'Camera and mic on', 'Full screen, single window, recorded'],
  ].map(([t, v, d]) => `<div class="plan-cell"><div class="t">${t}</div><div class="v">${esc(v)}</div><div class="d">${esc(d)}</div></div>`).join('');

  const instructions = `Welcome, ${st.name}. You are interviewing for ${st.role}. `
    + `The interview has two slots. Slot one has ${p.slot1} spoken questions, asked by an A I voice, on a ${Math.round(st.slot1TimeSec / 60)} minute clock. `
    + `Slot two has ${p.slot2} multiple choice questions and is fully text based. `
    + `Your camera and microphone must stay on the whole time, and the session is recorded. `
    + `Leaving full screen, switching windows, or opening another application ends the interview immediately. `
    + (st.needsAadhaar
      ? `Before slot one begins, you must type the twelve digit Aadhaar number from the card you applied with, take a photo of yourself holding that card, and read a sentence aloud to test your microphone. Keep your original Aadhaar card with you now. `
      : `Before slot one begins, you will be asked to verify your identity with a photo of yourself holding your I D card, and to read a sentence aloud to test your microphone. `)
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
      // Counting frames that are clearly above room noise gives the mic test a
      // way to prove the candidate actually spoke, even in browsers with no
      // speech recognition at all.
      if (peak > 12) S.loudFrames++;
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
  // Candidates who came through the application form prove the Aadhaar number
  // they applied with before they are allowed to photograph the card.
  if (S.needsAadhaar && !S.aadhaarOk) {
    $('#aadhaarPanel').classList.remove('hide');
    $('#aadhaarInput').focus();
    speak('First, please type the twelve digit Aadhaar number from the card you applied with.');
    return;
  }
  beginPhotoVerification();
}

function beginPhotoVerification() {
  $('#verifyPanel').classList.remove('hide');
  $('#verifyVideo').srcObject = S.stream;
  speak('Please hold your Aadhaar card next to your face so both are clearly visible, then press capture verification photo.');
}

$('#aadhaarInput').addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, 12);
});

$('#aadhaarBtn').addEventListener('click', async () => {
  const err = $('#aadhaarErr');
  const btn = $('#aadhaarBtn');
  err.className = 'banner hide';
  const value = $('#aadhaarInput').value.replace(/\D/g, '');
  if (value.length !== 12) {
    err.className = 'banner';
    err.textContent = 'Enter all 12 digits of your Aadhaar number.';
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Verifying…';
  try {
    await api('/verify-aadhaar', { aadhaar: value });
    S.aadhaarOk = true;
    $('#aadhaarInput').disabled = true;
    btn.classList.add('hide');
    err.className = 'banner go';
    err.textContent = 'Aadhaar number verified. Now capture your verification photo.';
    beginPhotoVerification();
  } catch (e) {
    err.className = 'banner';
    err.textContent = e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Verify Aadhaar number';
  }
});

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
  $('#captureBtn').textContent = 'Checking your identity…';
  try {
    const res = await fetch(`/api/interview/${TOKEN}/verification`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/octet-stream' },
      body: blob,
    });
    const data = await res.json().catch(() => ({}));

    // The server compares this photo against the one submitted with the
    // application. A mismatch stops the interview here, before any question.
    if (!res.ok) {
      err.className = 'banner';
      err.textContent = data.error || 'Identity verification failed.';
      err.classList.remove('hide');
      if (data.attemptsLeft === 0 || res.status === 403 && data.attemptsLeft === undefined) {
        $('#captureBtn').classList.add('hide');
        $('#retakeBtn').classList.add('hide');
        $('#verifyInstr').textContent =
          'Identity verification failed. This attempt has been locked and the hiring team notified.';
        speak('Identity verification failed. The interview cannot continue.');
      } else {
        speak('That photo did not match your application photo. Please face the camera in good light and try again.');
      }
      return;
    }

    S.verifyShot = URL.createObjectURL(blob);
    $('#shotPreview').src = S.verifyShot;
    $('#shotPreview').classList.remove('hide');
    $('#verifyVideo').classList.add('hide');
    $('#captureBtn').classList.add('hide');
    $('#retakeBtn').classList.remove('hide');
    const fm = data.faceMatch;
    if (fm && fm.status === 'verified') {
      err.className = 'banner go';
      err.textContent = 'Identity confirmed — you match the photo on your application.';
      err.classList.remove('hide');
    } else if (fm && fm.status === 'review') {
      err.className = 'banner warn';
      err.textContent = 'Your photo has been saved and will be checked by the hiring team.';
      err.classList.remove('hide');
    }
    beginMicTest();
  } catch (_) {
    err.className = 'banner';
    err.textContent = 'The photo could not be uploaded. Check your connection and try again.';
    err.classList.remove('hide');
  } finally {
    if (!$('#captureBtn').classList.contains('hide')) {
      $('#captureBtn').disabled = false;
      $('#captureBtn').textContent = 'Capture verification photo';
    }
  }
});

$('#retakeBtn').addEventListener('click', () => {
  $('#shotPreview').classList.add('hide');
  $('#verifyVideo').classList.remove('hide');
  $('#captureBtn').classList.remove('hide');
  $('#retakeBtn').classList.add('hide');
  $('#micTestPanel').classList.add('hide');
  $('#readyPanel').classList.add('hide');
  // A new photo means the microphone check has to be earned again.
  S.micTestPassed = false;
  clearInterval(S.micGateTimer);
  $('#micTestContinue').disabled = true;
});

// Minimum number of above-noise audio frames that counts as sound reaching the
// mic at all. This only drives the "we cannot hear you" hint - it never unlocks
// Continue on its own, because sound is not the same as reading the sentence.
const MIC_LOUD_FRAMES_REQUIRED = 40;
// Share of the sentence's words that must come back from recognition. Below 1.0
// so an odd mis-heard word does not trap someone who genuinely read it out.
const MIC_MATCH_REQUIRED = 0.7;

const micWords = (s) => String(s || '')
  .toLowerCase()
  .replace(/[^a-z0-9\s]/g, ' ')
  .split(/\s+/)
  .filter(Boolean);

// How much of the target sentence appears in what was heard, counting each word
// only as many times as the sentence actually uses it.
function micMatchRatio(target, heard) {
  const want = micWords(target);
  if (!want.length) return 0;
  const pool = new Map();
  for (const w of micWords(heard)) pool.set(w, (pool.get(w) || 0) + 1);
  let hit = 0;
  for (const w of want) {
    const n = pool.get(w) || 0;
    if (n > 0) { hit++; pool.set(w, n - 1); }
  }
  return hit / want.length;
}

function beginMicTest() {
  $('#micTestPanel').classList.remove('hide');
  // The server assigns the sentence so it can check the transcript against the
  // one actually given, rather than trusting whatever the page claims.
  S.micTarget = S.micSentence || MIC_TEST_SENTENCES[Math.floor(Math.random() * MIC_TEST_SENTENCES.length)];
  $('#micSentence').textContent = S.micTarget;
  $('#micTranscript').textContent = '';
  // Continue stays locked until the candidate has read this exact sentence out
  // loud AND the recording of it has been stored on the server.
  S.micTestPassed = false;
  S.micUploading = false;
  S.loudFrames = 0;
  S.micRestarts = 0;
  S.micHeard = '';
  S.micChunks = [];
  $('#micTestContinue').disabled = true;
  $('#micTestNote').textContent = 'Read the sentence above aloud to continue.';
  startMicRecording();
  speak('Now please read the sentence on the screen aloud, word for word. Your voice is being recorded for this check.',
    () => micTestListen());
}

// The reading is recorded and kept, so the admin can hear that the microphone
// genuinely worked rather than taking the transcript's word for it.
function startMicRecording() {
  S.micChunks = [];
  S.micRecorder = null;
  if (!S.stream || !window.MediaRecorder) return;
  try {
    const audioOnly = new MediaStream(S.stream.getAudioTracks());
    const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'];
    const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t));
    const rec = new MediaRecorder(audioOnly, mimeType ? { mimeType } : undefined);
    rec.ondataavailable = (e) => { if (e.data && e.data.size) S.micChunks.push(e.data); };
    rec.start(1000);
    S.micRecorder = rec;
  } catch (_) { S.micRecorder = null; }
}

function stopMicRecording() {
  return new Promise((resolve) => {
    const rec = S.micRecorder;
    if (!rec || rec.state === 'inactive') {
      return resolve(S.micChunks.length ? new Blob(S.micChunks, { type: 'audio/webm' }) : null);
    }
    rec.onstop = () => resolve(S.micChunks.length ? new Blob(S.micChunks, { type: 'audio/webm' }) : null);
    try { rec.stop(); } catch (_) { resolve(null); }
  });
}

// Reaching the word threshold is only step one: the recording still has to be
// uploaded and accepted before Continue unlocks.
async function passMicTest() {
  if (S.micTestPassed || S.micUploading) return;
  S.micUploading = true;
  clearInterval(S.micGateTimer);
  if (S.micTestRecog) { try { S.micTestRecog.stop(); } catch (_) {} }
  $('#micTestNote').textContent = 'Saving your voice recording…';

  const blob = await stopMicRecording();
  if (!blob || blob.size < 2048) {
    $('#micTestNote').textContent = 'Your voice was not recorded. Check your microphone and read the sentence again.';
    S.micUploading = false;
    S.micHeard = '';
    startMicRecording();
    micTestListen();
    return;
  }
  try {
    const fd = new FormData();
    fd.append('audio', blob, 'mictest.webm');
    fd.append('transcript', S.micHeard);
    const res = await fetch(`/api/interview/${TOKEN}/mic-test`, {
      method: 'POST', credentials: 'same-origin', body: fd,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'The recording could not be saved.');
    S.micTestPassed = true;
    $('#micTestNote').textContent = 'Microphone check passed — sentence read and recording saved.';
    $('#micTestContinue').disabled = false;
  } catch (e) {
    $('#micTestNote').textContent = `${e.message} Read the sentence aloud again.`;
    S.micHeard = '';
    startMicRecording();
    micTestListen();
  } finally {
    S.micUploading = false;
  }
}

function micTestGate() {
  clearInterval(S.micGateTimer);
  const startedAt = Date.now();
  S.micGateTimer = setInterval(() => {
    if (S.micTestPassed) { clearInterval(S.micGateTimer); return; }
    if (Date.now() - startedAt < 7000) return;
    // Distinguish "we hear nothing" from "we hear you but that is not the
    // sentence", because the two need different things from the candidate.
    if (S.loudFrames < MIC_LOUD_FRAMES_REQUIRED) {
      $('#micTestNote').textContent =
        'We cannot hear anything yet — check your microphone and read the sentence aloud.';
    } else if (!S.micHeard) {
      $('#micTestNote').textContent =
        'We can hear sound but no words yet — read the sentence clearly, at a normal pace.';
    }
  }, 900);
}

function micTestListen() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    // Without recognition the sentence cannot be checked at all - and Slot 1
    // needs it anyway, so stopping here is kinder than failing mid-interview.
    S.micTestSR = false;
    $('#micTestWarn').classList.remove('hide');
    $('#micTestNote').textContent = 'This browser cannot check your reading. Use Chrome or Edge to continue.';
    $('#micTestContinue').disabled = true;
    speak('This browser cannot capture speech. Please reopen your interview link in Chrome or Edge.');
    return;
  }
  S.micTestSR = true;
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
    if (finalChunk) S.micHeard = (S.micHeard ? S.micHeard.trim() + ' ' : '') + finalChunk.trim();
    const shown = S.micHeard + (interim ? ' ' + interim : '');
    $('#micTranscript').textContent = shown;

    const want = micWords(S.micTarget).length;
    const ratio = micMatchRatio(S.micTarget, shown);
    if (ratio >= MIC_MATCH_REQUIRED) {
      passMicTest();
    } else {
      $('#micTestNote').textContent =
        `${Math.round(ratio * want)} of ${want} words matched — keep reading the sentence above.`;
    }
  };
  recog.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      $('#micTestNote').textContent = 'Microphone access was blocked. Allow it, then reload this page.';
    }
  };
  recog.onend = () => {
    // Recognition drops out after pauses; keep it alive until they pass, with a
    // cap so a permanently broken service cannot spin forever.
    if (S.micTestPassed || S.micRestarts >= 30) return;
    if ($('#micTestPanel').classList.contains('hide')) return;
    S.micRestarts++;
    try { recog.start(); } catch (_) {}
  };
  try { recog.start(); } catch (_) {}
  S.micTestRecog = recog;
  micTestGate();
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

// Live identity monitoring. Frames go to the server, which runs the same face
// recogniser used for the verification photo and compares against the registered
// candidate - so this cannot be defeated by tampering with the page, and it works
// in every browser rather than only those with a built-in face detector.
const FACE_MONITOR_INTERVAL_MS = 12000;

const FACE_WARNINGS = {
  no_face: 'You are not visible in the camera. Stay in front of your camera.',
  multiple_faces: 'Another person is visible in the camera. You must be alone.',
  different_person: 'The person on camera does not match your registered photo.',
};

function startFaceMonitor() {
  clearInterval(S.monitorTimer);
  S.monitorTimer = setInterval(async () => {
    if (S.ended || S.monitorBusy) return;
    S.monitorBusy = true;
    try {
      const blob = await captureSnapshot();
      if (!blob) return;
      const res = await fetch(`/api/interview/${TOKEN}/face-check`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/octet-stream' },
        body: blob,
      });
      const data = await res.json().catch(() => ({}));
      const warning = FACE_WARNINGS[data.verdict];
      if (!warning) return;

      if (data.terminated) {
        showTopWarning(`⚠ ${warning}`);
        return finished('Result: Fail',
          'The interview was ended because the identity checks on your camera failed repeatedly. This attempt is recorded as a fail.', '×');
      }
      if (data.confirming) {
        // First sighting - warn, but it has not cost a strike yet.
        showTopWarning(`⚠ ${warning}`);
        return;
      }
      if (data.strike) {
        showTopWarning(`⚠ ${warning} (Warning ${data.strike} of ${data.maxStrikes || 3})`);
      }
    } catch (_) { /* a dropped check is retried on the next tick */ }
    finally { S.monitorBusy = false; }
  }, FACE_MONITOR_INTERVAL_MS);
}

function startProctorWatch() {
  startFaceMonitor();
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
  finished('Interview Submitted Successfully', 'Your final responses have been saved. Scoring your interview…', '✓');
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
  S.isLast = overall >= progress.total;
  $('#slotLabel').textContent = q.slot === 1 ? 'Slot 1 · Interview' : 'Slot 2 · Reasoning';
  $('#slotProgress').textContent = q.slot === 1
    ? `${progress.slot1.done + 1} / ${progress.slot1.total}`
    : `${progress.slot2.done + 1} / ${progress.slot2.total}`;
  $('#qNum').textContent = `Question ${overall} of ${progress.total}${q.slot === 2 ? ` · ${q.category}` : ''}`;
  $('#qText').textContent = q.text;
  $('#nextMcq').textContent = S.isLast ? 'Submit Interview' : 'Next question';
  $('#nextGame').textContent = S.isLast ? 'Submit Interview' : 'Submit sequence';
  $('#nextOpen').textContent = S.isLast ? 'Submit Interview' : 'Next question';

  $('#mcqArea').classList.add('hide');
  $('#openArea').classList.add('hide');
  $('#gameArea').classList.add('hide');
  $('#slot1DoneArea').classList.add('hide');

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
/* slot 2 mini-games: two distinct, clearly separated games            */
/* ------------------------------------------------------------------ */

function setupGame(q) {
  S.gamePick = [];
  $('#nextGame').disabled = true;
  const tilesEl = $('#tiles');
  tilesEl.innerHTML = '';

  if (q.gameKind === 'reorder') {
    S.gameSeq = q.layout;
    S.gamePlaying = false;
    $('#gameNote').textContent = 'Click the tiles in ascending numeric order — smallest first.';
    for (let i = 0; i < q.tiles; i++) {
      const t = document.createElement('div');
      t.className = 'tile';
      t.dataset.i = String(i);
      t.textContent = q.layout[i];
      t.addEventListener('click', () => onTileClick(i, q));
      tilesEl.appendChild(t);
    }
    return;
  }

  S.gameSeq = q.sequence;
  $('#gameNote').textContent = 'Watch the tiles light up in order…';
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
  if (q.gameKind === 'reorder' && S.gamePick.includes(i)) return;
  S.gamePick.push(i);
  const tile = $(`.tile[data-i="${i}"]`);
  if (tile) {
    tile.classList.add('picked');
    if (q.gameKind !== 'reorder') setTimeout(() => tile.classList.remove('picked'), 250);
  }
  $('#gameNote').textContent = `Picked ${S.gamePick.length} of ${S.gameSeq.length}.`;
  if (S.gamePick.length >= S.gameSeq.length) $('#nextGame').disabled = false;
}

$('#clearGame').addEventListener('click', () => {
  if (S.gamePlaying) return;
  $('#tiles').querySelectorAll('.tile').forEach((t) => t.classList.remove('picked'));
  if (S.question && S.question.gameKind === 'reorder') {
    S.gamePick = [];
    $('#nextGame').disabled = true;
    $('#gameNote').textContent = 'Cleared. Click the tiles in ascending numeric order — smallest first.';
    return;
  }
  S.gamePick = [];
  $('#nextGame').disabled = true;
  $('#gameNote').textContent = 'Cleared. Repeat the sequence by clicking the tiles in the same order.';
});
$('#nextGame').addEventListener('click', () => confirmFinalSubmit(() => submit(false)));

$('#nextOpen').addEventListener('click', () => confirmFinalSubmit(() => submit(false)));
$('#clearOpen').addEventListener('click', () => {
  S.transcript = '';
  $('#liveTranscript').textContent = '';
  if (!S.listening) startListening();
});
$('#nextMcq').addEventListener('click', () => {
  const sel = $('#opts').querySelector('input:checked');
  if (!sel) { $('#nextMcq').textContent = 'Pick an option first'; setTimeout(() => ($('#nextMcq').textContent = S.isLast ? 'Submit Interview' : 'Next question'), 1500); return; }
  confirmFinalSubmit(() => submit(false));
});

// The final question's button submits the whole interview, so it gets an
// explicit confirmation step — same disarm-then-rearm dance as the early-submit
// button, since opening a native confirm() blurs the window.
function confirmFinalSubmit(go) {
  if (!S.isLast) return go();
  const wasArmed = S.armed;
  S.armed = false;
  const ok = confirm('Submit the interview now? You will not be able to change any answers after this.');
  if (!ok) {
    setTimeout(() => { S.armed = wasArmed; }, 1500);
    return;
  }
  go();
}

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
      finished('Interview Submitted Successfully', 'Your final responses have been saved. Scoring your interview…', '✓');
      pollResult('Thank you — you can close this window.');
    } else {
      S.slot1Left = res.slot1RemainingSec;
      S.inSlot1 = res.inSlot1;
      if (q.slot === 1 && res.question.slot === 2) {
        showSlot1Done(res.question, res.progress);
      } else {
        renderQuestion(res.question, res.progress);
      }
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
      finished('Interview Submitted Successfully', 'Your final responses have been saved. Scoring your interview…', '✓');
      return pollResult('You can close this window.');
    }
    const wasSlot1 = S.question && S.question.slot === 1;
    S.inSlot1 = st.inSlot1;
    $('#clockCol').classList.toggle('hide', !S.inSlot1);
    if (st.question) {
      if (wasSlot1 && st.question.slot === 2) {
        showSlot1Done(st.question, st.progress);
      } else {
        renderQuestion(st.question, st.progress);
      }
    }
  } catch (_) { /* try again on the next tick */ }
}

function showSlot1Done(nextQ, nextProgress) {
  S.pendingNext = { q: nextQ, progress: nextProgress };
  S.question = null;
  stopListening();
  clearInterval(S.tick);
  $('#clockCol').classList.add('hide');
  $('#mcqArea').classList.add('hide');
  $('#openArea').classList.add('hide');
  $('#gameArea').classList.add('hide');
  $('#slot1DoneArea').classList.remove('hide');
  $('#slotLabel').textContent = 'Slot 1 · Interview';
  $('#slotProgress').textContent = 'Complete';
  $('#qNum').textContent = 'Slot 1 complete';
  $('#qTimer').textContent = '';
  $('#qText').textContent = 'Nice work — you have finished Slot 1.';
  $('#qBarFill').style.width = '100%';
}

$('#submitSlot1Btn').addEventListener('click', () => {
  if (!S.pendingNext) return;
  const wasArmed = S.armed;
  S.armed = false;
  const ok = confirm('Submit Slot 1 and continue to Slot 2? Slot 2 is text-only and you cannot go back to Slot 1 after this.');
  if (!ok) {
    setTimeout(() => { S.armed = wasArmed; }, 1500);
    return;
  }
  const { q, progress } = S.pendingNext;
  S.pendingNext = null;
  $('#slot1DoneArea').classList.add('hide');
  startClock();
  renderQuestion(q, progress);
});

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
  clearInterval(S.monitorTimer);
  clearInterval(S.micGateTimer);
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
