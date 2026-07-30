'use strict';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const api = async (url, opts = {}) => {
  const res = await fetch(url, { credentials: 'same-origin', ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
};
const fmtDate = (d) => (d ? new Date(d).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
const STATUS = { invited: 'Invited', in_progress: 'In progress', completed: 'Completed', terminated: 'Terminated' };

let CACHE = [];

/* ---------------- auth ---------------- */

/* ---------------- sign in: two panels, one door ---------------- */

const showErr = (msg) => { const e = $('#loginErr'); e.textContent = msg; e.classList.remove('hide'); };
const clearErr = () => $('#loginErr').classList.add('hide');

function selectTab(which) {
  clearErr();
  const admin = which === 'admin';
  $('#tabAdmin').classList.toggle('on', admin);
  $('#tabUser').classList.toggle('on', !admin);
  $('#tabAdmin').setAttribute('aria-selected', String(admin));
  $('#tabUser').setAttribute('aria-selected', String(!admin));
  $('#adminForm').classList.toggle('hide', !admin);
  $('#userForm').classList.toggle('hide', admin);
  (admin ? $('#au') : $('#ucode')).focus();
}
$('#tabAdmin').addEventListener('click', () => selectTab('admin'));
$('#tabUser').addEventListener('click', () => selectTab('user'));

$('#adminForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearErr();
  try {
    await api('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'admin', username: $('#au').value.trim(), password: $('#ap').value }),
    });
    boot();
  } catch (e2) { showErr(e2.message); }
});

// The candidate pastes the invitation link or just the code at the end of it.
const codeFrom = (raw) => {
  const m = String(raw).trim().match(/([0-9a-f]{16,})\s*$/i);
  return m ? m[1].toLowerCase() : '';
};

$('#userForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearErr();
  const token = codeFrom($('#ucode').value);
  if (!token) return showErr('That does not look like an interview link. Paste the whole link from your invitation.');
  try {
    await api('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'candidate', token, username: $('#uu').value.trim(), password: $('#up').value }),
    });
    location.href = `/i/${token}`;
  } catch (e2) { showErr(e2.message); }
});

// Arriving from a shared link that landed here rather than on /i/<code>
const fromQuery = new URLSearchParams(location.search).get('code');
if (fromQuery) { selectTab('user'); $('#ucode').value = fromQuery; }

$('#outBtn').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' });
  location.reload();
});

async function boot() {
  try {
    const me = await api('/api/auth/me');
    if (me.role !== 'admin') throw new Error('not signed in');
    $('#gate').classList.add('hide');
    $('#app').classList.remove('hide');
    load();
  } catch (_) {
    $('#gate').classList.remove('hide');
    $('#app').classList.add('hide');
  }
}

/* ---------------- list ---------------- */

async function load() {
  const { candidates, config } = await api('/api/admin/candidates');
  CACHE = candidates;
  $('#aiState').textContent = config.aiEnabled ? 'AI questions on' : 'question bank mode';
  const count = (s) => candidates.filter((c) => c.status === s).length;
  $('#stats').innerHTML = [
    ['Invited', count('invited')], ['In progress', count('in_progress')],
    ['Completed', count('completed')], ['Terminated', count('terminated')],
    ['Total', candidates.length],
  ].map(([l, n]) => `<div class="stat"><div class="n">${String(n).padStart(2, '0')}</div><div class="l">${l}</div></div>`).join('');

  if (!candidates.length) {
    $('#listWrap').innerHTML = '<div class="empty">No candidates yet. Add one to generate an interview link.</div>';
    return;
  }
  $('#listWrap').innerHTML = `<table class="grid"><thead><tr>
      <th>Candidate</th><th>Position</th><th>Status</th><th>Progress</th><th>Score</th><th>Flags</th><th>Added</th><th></th>
    </tr></thead><tbody>${candidates.map(row).join('')}</tbody></table>`;
}
$('#listWrap').addEventListener('click', onRowClick);

function row(c) {
  const idBadge = c.identityStatus === 'failed'
    ? '<span class="pill terminated" style="margin-left:6px" title="Face did not match the application photo">ID failed</span>'
    : c.identityStatus === 'review'
      ? '<span class="pill invited" style="margin-left:6px" title="Face match needs manual review">ID review</span>'
      : '';
  return `<tr>
    <td class="name-cell"><b>${esc(c.name)}</b><span>${esc(c.email || c.id)}</span></td>
    <td>${esc(c.role)}</td>
    <td><span class="pill ${c.status}">${STATUS[c.status]}</span>${idBadge}</td>
    <td class="mono" style="font-size:13px">${c.totalQuestions ? `${c.answered}/${c.totalQuestions}` : '—'}</td>
    <td class="mono" style="font-size:14px">${c.overall == null ? '—' : c.overall}</td>
    <td class="mono" style="font-size:13px;${c.violations ? 'color:var(--record)' : 'color:var(--graphite)'}">${c.violations || 0}</td>
    <td style="font-size:13px;color:var(--graphite)">${fmtDate(c.createdAt)}</td>
    <td><div class="row-actions">
      <button class="btn ghost sm" data-copy="${c.token}">Copy link</button>
      <button class="btn sm" data-open="${c.id}">Open</button>
    </div></td>
  </tr>`;
}

function onRowClick(e) {
  const copy = e.target.closest('[data-copy]');
  if (copy) {
    navigator.clipboard.writeText(`${location.origin}/i/${copy.dataset.copy}`);
    copy.textContent = 'Copied';
    setTimeout(() => (copy.textContent = 'Copy link'), 1400);
    return;
  }
  const open = e.target.closest('[data-open]');
  if (open) showDetail(open.dataset.open);
}

$('#refreshBtn').addEventListener('click', load);
setInterval(() => { if (!$('#app').classList.contains('hide') && $('#detailSheet').classList.contains('hide')) load(); }, 20000);

/* ---------------- new candidate ---------------- */

const openNew = () => { $('#newBg').classList.remove('hide'); $('#newSheet').classList.remove('hide'); };
const closeNew = () => {
  $('#newBg').classList.add('hide'); $('#newSheet').classList.add('hide');
  $('#newForm').reset(); $('#newForm').classList.remove('hide'); $('#newDone').classList.add('hide');
  load();
};
$('#newBtn').addEventListener('click', openNew);
$('#newBg').addEventListener('click', closeNew);
document.querySelectorAll('[data-close-new]').forEach((b) => b.addEventListener('click', closeNew));

$('#newForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');
  const err = $('#newErr');
  err.classList.add('hide');
  btn.disabled = true; btn.textContent = 'Creating and sending invitation email…';
  try {
    const res = await fetch('/api/admin/candidates', { method: 'POST', body: new FormData(e.target), credentials: 'same-origin' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not create the candidate.');
    $('#newLink').value = `${location.origin}/i/${data.candidate.token}`;
    $('#credUser').textContent = data.username;
    $('#credPass').textContent = data.password;
    const mailNote = $('#mailNote');
    if (data.emailSent) {
      mailNote.textContent = `✓ Invitation email sent to ${data.candidate.email}.`;
      mailNote.style.color = 'var(--live)';
    } else {
      mailNote.textContent = `⚠ Could not send the invitation email (${data.emailMessage || 'unknown error'}). Copy the link and send it manually.`;
      mailNote.style.color = 'var(--record)';
    }
    $('#newForm').classList.add('hide');
    $('#newDone').classList.remove('hide');
  } catch (e2) {
    err.textContent = e2.message; err.classList.remove('hide');
  } finally {
    btn.disabled = false; btn.textContent = 'Create candidate and generate link';
  }
});

$('#copyNew').addEventListener('click', (e) => {
  navigator.clipboard.writeText($('#newLink').value);
  e.target.textContent = 'Copied';
  setTimeout(() => (e.target.textContent = 'Copy'), 1400);
});

/* ---------------- detail ---------------- */

const closeDetail = () => { $('#detailBg').classList.add('hide'); $('#detailSheet').classList.add('hide'); load(); };
$('#detailBg').addEventListener('click', closeDetail);
document.querySelectorAll('[data-close-detail]').forEach((b) => b.addEventListener('click', closeDetail));

async function showDetail(id) {
  // Slide the panel in immediately so the click feels instant, then drop in
  // the candidate's complete record (transcript, answers, report, evidence)
  // as soon as the fetch resolves.
  const cached = CACHE.find((x) => x.id === id);
  $('#detailBg').classList.remove('hide');
  $('#detailSheet').classList.remove('hide');
  $('#detailName').textContent = cached ? cached.name : 'Candidate';
  $('#detailBody').innerHTML = '<div class="card">Loading record…</div>';
  DETAIL_ID = id;
  let c;
  try {
    c = await api(`/api/admin/candidates/${id}`);
  } catch (e) {
    if (DETAIL_ID !== id) return;
    $('#detailBody').innerHTML = `<div class="card"><h3 style="color:var(--record)">Could not load this record</h3><p style="font-size:14px;margin:0">${esc(e.message)}</p></div>`;
    return;
  }
  if (DETAIL_ID !== id) return;   // the admin already opened a different record
  $('#detailName').textContent = c.name;
  $('#detailBody').innerHTML = detailHtml(c);
}

let DETAIL_ID = null;
$('#detailBody').addEventListener('click', async (e) => {
  const id = DETAIL_ID;
  if (!id) return;
  const toApp = e.target.closest('[data-open-app]');
  if (toApp) {
    e.preventDefault();
    closeDetail();
    selectPane('applications');
    showAppDetail(toApp.dataset.openApp);
    return;
  }
  {
    if (e.target.id === 'delBtn') {
      if (!confirm('Delete this candidate, their transcript and their recording? This cannot be undone.')) return;
      await api(`/api/admin/candidates/${id}`, { method: 'DELETE' });
      closeDetail();
    }
    if (e.target.id === 'resetBtn') {
      if (!confirm('Clear this attempt? The transcript and scores are removed. The same link, username and password will keep working.')) return;
      await api(`/api/admin/candidates/${id}/reset`, { method: 'POST' });
      showDetail(id);
    }
    if (e.target.id === 'editBtn') {
      openEdit(CACHE.find((x) => x.id === id) || {});
    }
    if (e.target.id === 'faceMatchBtn') {
      e.target.disabled = true;
      e.target.textContent = 'Comparing photos…';
      try {
        await api(`/api/admin/candidates/${id}/face-match`, { method: 'POST' });
        showDetail(id);
      } catch (e2) {
        alert(e2.message);
        e.target.disabled = false;
        e.target.textContent = 'Re-run face match';
      }
    }
    if (e.target.id === 'copyDetail') {
      navigator.clipboard.writeText($('#detailLink').value);
      e.target.textContent = 'Copied';
      setTimeout(() => (e.target.textContent = 'Copy'), 1400);
    }
  }
});

function detailHtml(c) {
  const r = c.report;
  const bySlot = (n) => c.questions.filter((q) => q.slot === n);
  const ans = (qid) => c.answers.find((a) => a.questionId === qid);

  const overview = `<div class="card">
    <h3>Record</h3>
    <dl class="kv">
      <dt>Status</dt><dd><span class="pill ${c.status}">${STATUS[c.status]}</span></dd>
      <dt>Position</dt><dd>${esc(c.role)}${c.experience ? ` · ${esc(c.experience)}` : ''}</dd>
      <dt>Email</dt><dd>${esc(c.email || '—')}</dd>
      <dt>Sign-in username</dt><dd class="mono">${esc(c.username || '—')}</dd>
      <dt>Sign-in password</dt><dd class="mono">${esc(c.password || '—')}</dd>
      <dt>Link valid from</dt><dd>${c.scheduleStart ? fmtDate(c.scheduleStart) : '<span style="color:var(--graphite)">No restriction</span>'}</dd>
      <dt>Link valid until</dt><dd>${c.scheduleEnd ? fmtDate(c.scheduleEnd) : '<span style="color:var(--graphite)">No restriction</span>'}</dd>
      <dt>Started</dt><dd>${fmtDate(c.startedAt)}</dd>
      <dt>Finished</dt><dd>${fmtDate(c.finishedAt)}</dd>
      <dt>Answered</dt><dd class="mono">${c.answered} of ${c.totalQuestions || '—'}</dd>
      <dt>Question source</dt><dd class="mono" style="font-size:13px">${esc(c.generatedBy || 'not generated yet')}</dd>
      ${c.resumeFile ? `<dt>Resume file</dt><dd><a href="/api/admin/candidates/${c.id}/resume">Download</a></dd>` : ''}
      <dt>ID verification</dt><dd>${c.hasVerification ? 'Captured' : '<span style="color:var(--graphite)">Not captured</span>'}</dd>
    </dl>
    ${c.hasVerification && !c.application ? `
    <a href="/api/admin/candidates/${c.id}/verification" target="_blank" style="display:inline-block;margin-top:12px">
      <img src="/api/admin/candidates/${c.id}/verification" alt="ID verification photo" style="max-width:220px;border-radius:4px;border:1px solid var(--line);display:block">
    </a>` : ''}
    <div class="linkbox" style="margin-top:16px">
      <input id="detailLink" readonly value="${location.origin}/i/${c.token}">
      <button class="btn sm" id="copyDetail">Copy</button>
    </div>
    <div style="display:flex;gap:8px;margin-top:16px">
      <button class="btn ghost sm" id="resetBtn">Reset attempt</button>
      <button class="btn ghost sm" id="editBtn">Edit profile</button>
      <button class="btn danger sm" id="delBtn">Delete candidate</button>
    </div>
  </div>`;

  // Side-by-side identity check: what they submitted when they applied vs. what
  // they proved at the start of the interview.
  const app = c.application;
  const fm = c.faceMatch;
  const FACE_LABEL = { verified: 'Face matched', failed: 'Identity verification failed', review: 'Needs manual review' };
  const faceBlock = !app ? '' : `
    <div style="border-top:1px solid var(--line);margin-top:14px;padding-top:14px">
      <dl class="kv">
        <dt>Face match</dt><dd>${
          !fm
            ? '<span style="color:var(--graphite)">Not checked yet — no interview photo taken</span>'
            : `<span class="pill ${fm.status === 'verified' ? 'in_progress' : fm.status === 'failed' ? 'terminated' : 'invited'}">${FACE_LABEL[fm.status] || esc(fm.status)}</span>`
        }</dd>
        ${fm ? `
        <dt>Confidence score</dt><dd class="mono">${
          fm.score == null ? '—' : `${fm.score} <span style="color:var(--graphite);font-size:12.5px">(needs ≥ ${fm.threshold})</span>`
        }</dd>
        <dt>Checked at</dt><dd>${fmtDate(fm.checkedAt)}</dd>
        <dt>Attempts used</dt><dd class="mono">${c.faceAttempts} of ${c.maxFaceAttempts}${c.identityBlocked ? ' <span class="tag-bad">— locked out</span>' : ''}</dd>
        <dt>Detail</dt><dd style="font-size:13.5px">${esc(fm.detail || '')}</dd>` : ''}
      </dl>
      <button class="btn ghost sm" id="faceMatchBtn" style="margin-top:12px">${fm ? 'Re-run face match' : 'Run face match'}</button>
      ${c.identityBlocked ? '<p class="hint" style="margin:10px 0 0">This attempt is locked. A passing re-run clears it, or use <b>Reset attempt</b> to let the candidate start over.</p>' : ''}
    </div>`;

  const identity = app ? `<div class="card"${fm && fm.status === 'failed' ? ' style="border-color:#e6c4bf"' : ''}>
    <h3${fm && fm.status === 'failed' ? ' style="color:var(--record)"' : ''}>Identity check against application</h3>
    <dl class="kv">
      <dt>Aadhaar on application</dt><dd class="mono">${esc(app.aadhaarMasked || '—')}</dd>
      <dt>Aadhaar entered at interview</dt><dd>${
        c.aadhaarVerified
          ? '<span class="tag-ok">Matched</span>'
          : `<span class="tag-bad">Not verified</span>${c.aadhaarAttempts ? ` <span class="mono" style="font-size:12.5px;color:var(--graphite)">(${c.aadhaarAttempts} failed attempt${c.aadhaarAttempts === 1 ? '' : 's'})</span>` : ''}`
      }</dd>
      <dt>Name on application</dt><dd>${esc(app.name)}${app.name !== c.name ? ' <span class="tag-bad">differs from candidate record</span>' : ''}</dd>
      <dt>Mobile on application</dt><dd class="mono">${esc(app.mobile || '—')}</dd>
      <dt>Application ATS score</dt><dd class="mono">${app.atsScore}</dd>
      <dt>Full application</dt><dd><a href="#" data-open-app="${app.id}">Open application record</a></dd>
    </dl>
    <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:14px">
      ${app.hasPhoto ? `<div>
        <span class="hint" style="display:block;margin:0 0 6px">Photo submitted when applying</span>
        <a href="/api/admin/applications/${app.id}/photo" target="_blank">
          <img src="/api/admin/applications/${app.id}/photo" alt="Photo from application" style="max-width:200px;border-radius:4px;border:1px solid var(--line);display:block">
        </a>
      </div>` : ''}
      ${c.hasVerification ? `<div>
        <span class="hint" style="display:block;margin:0 0 6px">Live photo taken at the interview</span>
        <a href="/api/admin/candidates/${c.id}/verification" target="_blank">
          <img src="/api/admin/candidates/${c.id}/verification" alt="Live verification photo" style="max-width:200px;border-radius:4px;border:1px solid var(--line);display:block">
        </a>
      </div>` : ''}
    </div>
    ${app.hasPhoto && c.hasVerification ? '<p class="hint" style="margin:12px 0 0">Compare the two photos above to confirm the same person applied and sat the interview.</p>' : ''}
    ${faceBlock}
  </div>` : '';

  const MONITOR_LABEL = {
    no_face: 'Candidate not visible',
    multiple_faces: 'More than one person on camera',
    different_person: 'Different person on camera',
  };
  const monitoring = (c.faceEvents || []).length ? `<div class="card" style="border-color:#e6c4bf">
    <h3 style="color:var(--record)">Live face monitoring — ${c.faceEvents.length} event${c.faceEvents.length === 1 ? '' : 's'}</h3>
    <p class="hint" style="margin-top:0">The camera was checked against the registered photo every 12 seconds during the interview. Strike ${c.faceStrikes} of ${c.maxFaceStrikes} reached.</p>
    <div style="display:flex;gap:12px;flex-wrap:wrap">
      ${c.faceEvents.map((ev) => `
        <div style="width:170px">
          <a href="/api/admin/candidates/${c.id}/evidence/${encodeURIComponent(ev.evidenceFile)}" target="_blank">
            <img src="/api/admin/candidates/${c.id}/evidence/${encodeURIComponent(ev.evidenceFile)}"
                 alt="${esc(MONITOR_LABEL[ev.type] || ev.type)}"
                 style="width:170px;height:128px;object-fit:cover;border-radius:4px;border:1px solid var(--line);display:block">
          </a>
          <div style="font-size:12.5px;font-weight:600;margin-top:6px;color:var(--record)">${esc(MONITOR_LABEL[ev.type] || ev.type)}</div>
          <div class="mono" style="font-size:11.5px;color:var(--graphite)">
            ${fmtDate(ev.at)}${ev.atQuestion ? ` · Q${ev.atQuestion}` : ''}<br>
            ${ev.faces != null ? `${ev.faces} face${ev.faces === 1 ? '' : 's'}` : ''}${ev.score != null ? ` · score ${ev.score}` : ''}<br>
            strike ${ev.strike || '—'}
          </div>
        </div>`).join('')}
    </div>
  </div>` : (c.status === 'invited' ? '' : `<div class="card">
    <h3>Live face monitoring</h3>
    <p style="font-size:14px;color:var(--graphite);margin:0">No identity problems were detected on camera during this interview.</p>
  </div>`);

  const micTest = c.micTest ? `<div class="card">
    <h3>Microphone check</h3>
    <dl class="kv">
      <dt>Sentence given</dt><dd style="font-size:13.5px">${esc(c.micTest.sentence || '—')}</dd>
      <dt>What was heard</dt><dd style="font-size:13.5px">${esc(c.micTest.transcript || '—')}</dd>
      <dt>Words matched</dt><dd class="mono">${Math.round((c.micTest.matchRatio || 0) * 100)}%</dd>
      <dt>Recorded at</dt><dd>${fmtDate(c.micTest.capturedAt)}</dd>
      <dt>Recording size</dt><dd class="mono">${((c.micTest.bytes || 0) / 1024).toFixed(0)} KB</dd>
    </dl>
    <audio controls preload="metadata" src="/api/admin/candidates/${c.id}/mic-test" style="width:100%;margin-top:12px"></audio>
  </div>` : `<div class="card">
    <h3>Microphone check</h3>
    <p style="font-size:14px;color:var(--graphite);margin:0">Not completed — no voice recording was captured.</p>
  </div>`;

  const flags = c.violations.length ? `<div class="card" style="border-color:#e6c4bf">
    <h3 style="color:var(--record)">Integrity flags</h3>
    <ul class="plain">${c.violations.map((v) => `<li><span class="mono">${fmtDate(v.at)}</span> — ${esc(v.type)}${v.detail ? `: ${esc(v.detail)}` : ''} (at question ${v.atQuestion})</li>`).join('')}</ul>
  </div>` : '';

  // Face-monitoring frames live in evidenceShots too (that is what authorises
  // serving them), but they are shown in their own card above, not twice.
  const otherEvidence = (c.evidenceShots || []).filter((s) => !MONITOR_LABEL[s.type]);
  const evidence = otherEvidence.length ? `<div class="card">
    <h3>Evidence photos</h3>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      ${otherEvidence.map((s) => `
        <a href="/api/admin/candidates/${c.id}/evidence/${s.file}" target="_blank" style="text-align:center">
          <img src="/api/admin/candidates/${c.id}/evidence/${s.file}" style="width:110px;height:82px;object-fit:cover;border-radius:4px;border:1px solid var(--line);display:block">
          <span class="hint" style="margin:4px 0 0;display:block">${esc(s.type)} · Q${s.atQuestion}</span>
        </a>`).join('')}
    </div>
  </div>` : '';

  const recording = c.hasRecording ? `<div class="card">
    <h3>Session recording</h3>
    <video class="rec" controls preload="metadata" src="/api/admin/candidates/${c.id}/recording"></video>
    <p class="hint" style="margin:10px 0 0">${(c.recordingBytes / 1048576).toFixed(1)} MB · camera and microphone, recorded from the moment the interview started.</p>
  </div>` : `<div class="card"><h3>Session recording</h3><p style="font-size:14px;color:var(--graphite);margin:0">No recording was captured for this attempt.</p></div>`;

  let report = '';
  if (r) {
    const cat = r.objective.byCategory || {};
    report = `<div class="card">
      <h3>Assessment</h3>
      <div class="score-strip">
        <div class="score"><div class="n">${r.overall}</div><div class="l">Overall</div></div>
        <div class="score"><div class="n">${r.objective.correct}/${r.objective.total}</div><div class="l">Objective</div></div>
        <div class="score"><div class="n">${r.openAvg == null ? '—' : r.openAvg}</div><div class="l">Spoken avg /10</div></div>
        <div class="score"><div class="n" style="font-size:16px;text-transform:capitalize">${esc(r.recommendation)}</div><div class="l">Call</div></div>
      </div>
      <div class="bars" style="margin-top:18px">
        ${Object.entries(cat).map(([k, v]) => `<div class="bar-row"><span style="text-transform:capitalize">${esc(k)}</span><span class="bar"><i style="width:${v.total ? (v.correct / v.total) * 100 : 0}%"></i></span><span class="mono" style="font-size:12.5px">${v.correct}/${v.total}</span></div>`).join('')}
      </div>
      <p style="font-size:14.5px;margin:16px 0 0">${esc(r.summary)}</p>
      ${r.strengths.length ? `<h3 style="margin-top:18px">Strengths</h3><ul class="plain">${r.strengths.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
      ${r.concerns.length ? `<h3 style="margin-top:16px">Concerns</h3><ul class="plain">${r.concerns.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
    </div>`;
  }

  const slot1 = bySlot(1).length ? `<div class="card">
    <h3>Slot 1 · Interview transcript</h3>
    ${bySlot(1).map((q) => {
      const a = ans(q.id);
      const score = r && r.perQuestion ? r.perQuestion.find((p) => Number(p.n) === q.n) : null;
      return `<div class="qa">
        <div class="q"><i>Q${q.n}</i>${esc(q.text)}</div>
        <div class="a">${a && a.text ? esc(a.text) : '<span style="color:var(--graphite)">No answer recorded.</span>'}</div>
        <div class="meta">${a ? `${a.timeSpentSec}s used` : 'not reached'}${score ? ` · scored ${score.score}/10 — ${esc(score.comment || '')}` : ''}</div>
      </div>`;
    }).join('')}
  </div>` : '';

  const slot2 = bySlot(2).length ? `<div class="card">
    <h3>Slot 2 · Reasoning and role knowledge</h3>
    ${bySlot(2).map((q) => {
      const a = ans(q.id);
      if (q.type === 'game') {
        const picked = a && a.sequence ? a.sequence.join(', ') : null;
        const ok = a && a.correct;
        const isReorder = q.gameKind === 'reorder';
        const target = isReorder ? q.answerOrder : q.sequence;
        const targetLabel = isReorder ? 'Correct click order' : 'Target sequence';
        const extra = isReorder ? ` · tile numbers shown: [${esc((q.layout || []).join(', '))}]` : '';
        return `<div class="qa">
          <div class="q"><i>Q${q.n} · ${esc(q.category)} · ${isReorder ? 'number order game' : 'memory game'}</i>${esc(q.text)}</div>
          <div class="a">${picked ? `${ok ? '<span class="tag-ok">Correct</span>' : '<span class="tag-bad">Incorrect</span>'} — clicked [${esc(picked)}]` : '<span style="color:var(--graphite)">No answer recorded.</span>'}</div>
          <div class="meta">${targetLabel}: [${esc((target || []).join(', '))}]${extra}${a ? ` · ${a.timeSpentSec}s used` : ''}</div>
        </div>`;
      }
      const chosen = a && a.choice != null ? q.options[a.choice] : null;
      const ok = a && a.correct;
      return `<div class="qa">
        <div class="q"><i>Q${q.n} · ${esc(q.category)}</i>${esc(q.text)}</div>
        <div class="a">${chosen ? `${ok ? '<span class="tag-ok">Correct</span>' : '<span class="tag-bad">Incorrect</span>'} — chose “${esc(chosen)}”` : '<span style="color:var(--graphite)">No answer recorded.</span>'}</div>
        <div class="meta">Correct answer: ${esc(q.options[q.answerIndex])}${a ? ` · ${a.timeSpentSec}s used` : ''}</div>
      </div>`;
    }).join('')}
  </div>` : '';

  return overview + identity + monitoring + micTest + flags + evidence + report + recording + slot1 + slot2;
}

/* ---------------- edit profile ---------------- */

let EDIT_ID = null;

function openEdit(c) {
  EDIT_ID = c.id;
  const f = $('#editForm');
  f.reset();
  $('#editErr').classList.add('hide');
  f.elements.name.value = c.name || '';
  f.elements.email.value = c.email || '';
  f.elements.role.value = c.role || '';
  if (c.experience) f.elements.experience.value = c.experience;
  f.elements.scheduleStart.value = c.scheduleStart ? c.scheduleStart.slice(0, 10) : '';
  f.elements.scheduleEnd.value = c.scheduleEnd ? c.scheduleEnd.slice(0, 10) : '';
  $('#editBg').classList.remove('hide');
  $('#editSheet').classList.remove('hide');
}
const closeEdit = () => { $('#editBg').classList.add('hide'); $('#editSheet').classList.add('hide'); };
$('#editBg').addEventListener('click', closeEdit);
document.querySelectorAll('[data-close-edit]').forEach((b) => b.addEventListener('click', closeEdit));

$('#editForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');
  const err = $('#editErr');
  err.classList.add('hide');
  const fd = new FormData(e.target);
  const body = Object.fromEntries(fd.entries());
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    await api(`/api/admin/candidates/${EDIT_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    closeEdit();
    await load();
    if (!$('#detailSheet').classList.contains('hide')) showDetail(EDIT_ID);
  } catch (e2) {
    err.textContent = e2.message; err.classList.remove('hide');
  } finally {
    btn.disabled = false; btn.textContent = 'Save changes';
  }
});

/* ---------------- applications tab ---------------- */

const APP_STATUS = { submitted: 'Submitted', invited: 'Invited', rejected: 'Rejected' };
let APP_CACHE = [];
let APP_SETTINGS = null;

function selectPane(which) {
  const apps = which === 'applications';
  $('#tabCandidates').classList.toggle('on', !apps);
  $('#tabApplications').classList.toggle('on', apps);
  $('#tabCandidates').setAttribute('aria-selected', String(!apps));
  $('#tabApplications').setAttribute('aria-selected', String(apps));
  $('#paneCandidates').classList.toggle('hide', apps);
  $('#paneApplications').classList.toggle('hide', !apps);
  if (apps) loadApplications();
}
$('#tabCandidates').addEventListener('click', () => selectPane('candidates'));
$('#tabApplications').addEventListener('click', () => selectPane('applications'));

async function loadApplications() {
  const params = new URLSearchParams();
  const status = $('#appStatusFilter').value;
  const q = $('#appSearch').value.trim();
  const minScore = $('#appMinScore').value;
  const maxScore = $('#appMaxScore').value;
  if (status) params.set('status', status);
  if (q) params.set('q', q);
  if (minScore) params.set('minScore', minScore);
  if (maxScore) params.set('maxScore', maxScore);
  const { applications, settings } = await api(`/api/admin/applications?${params}`);
  APP_CACHE = applications;
  APP_SETTINGS = settings;

  const count = (s) => applications.filter((a) => a.status === s).length;
  $('#appStats').innerHTML = [
    ['Submitted', count('submitted')], ['Invited', count('invited')],
    ['Rejected', count('rejected')], ['Total', applications.length],
  ].map(([l, n]) => `<div class="stat"><div class="n">${String(n).padStart(2, '0')}</div><div class="l">${l}</div></div>`).join('');

  if (!applications.length) {
    $('#appListWrap').innerHTML = '<div class="empty">No applications yet. Share the application link to start receiving candidates.</div>';
    return;
  }
  $('#appListWrap').innerHTML = `<table class="grid"><thead><tr>
      <th>Applicant</th><th>Mobile</th><th>ATS score</th><th>Status</th><th>Applied</th><th></th>
    </tr></thead><tbody>${applications.map(appRow).join('')}</tbody></table>`;
}

function appRow(a) {
  const scoreColor = a.atsScore >= (APP_SETTINGS?.atsThreshold ?? 60) ? 'var(--live)' : 'var(--record)';
  return `<tr>
    <td class="name-cell"><b>${esc(a.name)}</b><span>${esc(a.email)}</span></td>
    <td class="mono" style="font-size:13px">${esc(a.mobile || '—')}</td>
    <td class="mono" style="font-size:14px;color:${scoreColor}">${a.atsScore}</td>
    <td><span class="pill ${a.status}">${APP_STATUS[a.status]}</span></td>
    <td style="font-size:13px;color:var(--graphite)">${fmtDate(a.createdAt)}</td>
    <td><div class="row-actions"><button class="btn sm" data-open-app="${a.id}">Open</button></div></td>
  </tr>`;
}

$('#appListWrap').addEventListener('click', (e) => {
  const open = e.target.closest('[data-open-app]');
  if (open) showAppDetail(open.dataset.openApp);
});
$('#appFilterBtn').addEventListener('click', loadApplications);
$('#appRefreshBtn').addEventListener('click', loadApplications);
$('#appSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadApplications(); });

let APP_DETAIL_ID = null;

const closeAppDetail = () => { $('#appDetailBg').classList.add('hide'); $('#appDetailSheet').classList.add('hide'); loadApplications(); };
$('#appDetailBg').addEventListener('click', closeAppDetail);
document.querySelectorAll('[data-close-app-detail]').forEach((b) => b.addEventListener('click', closeAppDetail));

async function showAppDetail(id) {
  const cached = APP_CACHE.find((x) => x.id === id);
  $('#appDetailBg').classList.remove('hide');
  $('#appDetailSheet').classList.remove('hide');
  $('#appDetailName').textContent = cached ? cached.name : 'Application';
  $('#appDetailBody').innerHTML = '<div class="card">Loading record…</div>';
  APP_DETAIL_ID = id;
  let a;
  try {
    a = await api(`/api/admin/applications/${id}`);
  } catch (e) {
    if (APP_DETAIL_ID !== id) return;
    $('#appDetailBody').innerHTML = `<div class="card"><h3 style="color:var(--record)">Could not load this record</h3><p style="font-size:14px;margin:0">${esc(e.message)}</p></div>`;
    return;
  }
  if (APP_DETAIL_ID !== id) return;
  $('#appDetailName').textContent = a.name;
  $('#appDetailBody').innerHTML = appDetailHtml(a);
}

function appDetailHtml(a) {
  const matches = (a.atsMatches || []).map((m) => `<li>${esc(m.term)} <span class="mono" style="color:var(--graphite)">(+${m.weight})</span></li>`).join('');
  return `<div class="card">
    <h3>Applicant</h3>
    <dl class="kv">
      <dt>Status</dt><dd><span class="pill ${a.status}">${APP_STATUS[a.status]}</span></dd>
      <dt>Email</dt><dd>${esc(a.email)}</dd>
      <dt>Mobile</dt><dd class="mono">${esc(a.mobile || '—')}</dd>
      <dt>Aadhaar</dt><dd class="mono" id="aadhaarVal">${esc(a.aadhaarMasked || '—')} ${a.aadhaarMasked ? '<button class="btn ghost sm" id="revealAadhaarBtn" type="button" style="margin-left:8px">Reveal</button>' : ''}</dd>
      <dt>Applied</dt><dd>${fmtDate(a.createdAt)}</dd>
      <dt>Resume</dt><dd>${a.hasResume ? `<a href="/api/admin/applications/${a.id}/resume">Download</a>` : '—'}</dd>
      <dt>Decision email</dt><dd>${a.emailSent == null ? '<span style="color:var(--graphite)">Not processed yet</span>' : (a.emailSent ? `<span style="color:var(--live)">Sent</span> — ${esc(a.emailMessage || '')}` : `<span style="color:var(--record)">Failed</span> — ${esc(a.emailMessage || '')}`)}</dd>
    </dl>
    ${a.hasPhoto ? `<a href="/api/admin/applications/${a.id}/photo" target="_blank" style="display:inline-block;margin-top:12px">
      <img src="/api/admin/applications/${a.id}/photo" alt="Applicant photo" style="max-width:160px;border-radius:4px;border:1px solid var(--line);display:block">
    </a>` : ''}
    <div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap">
      <button class="btn ghost sm" id="rescanBtn">Recalculate ATS</button>
      <button class="btn go sm" id="processBtn">Process (send decision email)</button>
      <button class="btn ghost sm" id="appEditBtn">Edit</button>
      <button class="btn danger sm" id="appDelBtn">Delete</button>
    </div>
  </div>
  <div class="card">
    <h3>ATS score</h3>
    <div class="score-strip">
      <div class="score"><div class="n">${a.atsScore}</div><div class="l">Score /100</div></div>
      <div class="score"><div class="n" style="font-size:16px">${a.atsScore >= (APP_SETTINGS?.atsThreshold ?? 60) ? 'Meets criteria' : 'Below criteria'}</div><div class="l">Verdict</div></div>
    </div>
    ${matches ? `<h3 style="margin-top:18px">Matched keywords</h3><ul class="plain">${matches}</ul>` : '<p class="hint" style="margin-top:14px">No configured keywords were found in this resume.</p>'}
  </div>`;
}

$('#appDetailBody').addEventListener('click', async (e) => {
  const id = APP_DETAIL_ID;
  if (!id) return;
  if (e.target.id === 'revealAadhaarBtn') {
    const { aadhaar } = await api(`/api/admin/applications/${id}/reveal-aadhaar`, { method: 'POST' });
    $('#aadhaarVal').innerHTML = `<span class="mono">${esc(aadhaar)}</span>`;
  }
  if (e.target.id === 'rescanBtn') {
    await api(`/api/admin/applications/${id}/rescan`, { method: 'POST' });
    showAppDetail(id);
  }
  if (e.target.id === 'processBtn') {
    if (!confirm('Send this applicant the automatic decision email now, based on their current ATS score?')) return;
    await api(`/api/admin/applications/${id}/process`, { method: 'POST' });
    showAppDetail(id);
  }
  if (e.target.id === 'appEditBtn') {
    openAppEdit(APP_CACHE.find((x) => x.id === id) || {});
  }
  if (e.target.id === 'appDelBtn') {
    if (!confirm('Delete this application, its photo and resume? This cannot be undone.')) return;
    await api(`/api/admin/applications/${id}`, { method: 'DELETE' });
    closeAppDetail();
  }
});

/* ---------------- edit application ---------------- */

let APP_EDIT_ID = null;
function openAppEdit(a) {
  APP_EDIT_ID = a.id;
  const f = $('#appEditForm');
  f.reset();
  $('#appEditErr').classList.add('hide');
  f.elements.name.value = a.name || '';
  f.elements.email.value = a.email || '';
  f.elements.mobile.value = a.mobile || '';
  f.elements.status.value = a.status || 'submitted';
  $('#appEditBg').classList.remove('hide');
  $('#appEditSheet').classList.remove('hide');
}
const closeAppEdit = () => { $('#appEditBg').classList.add('hide'); $('#appEditSheet').classList.add('hide'); };
$('#appEditBg').addEventListener('click', closeAppEdit);
document.querySelectorAll('[data-close-app-edit]').forEach((b) => b.addEventListener('click', closeAppEdit));

$('#appEditForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');
  const err = $('#appEditErr');
  err.classList.add('hide');
  const fd = new FormData(e.target);
  const body = Object.fromEntries(fd.entries());
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    await api(`/api/admin/applications/${APP_EDIT_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    closeAppEdit();
    await loadApplications();
    if (!$('#appDetailSheet').classList.contains('hide')) showAppDetail(APP_EDIT_ID);
  } catch (e2) {
    err.textContent = e2.message; err.classList.remove('hide');
  } finally {
    btn.disabled = false; btn.textContent = 'Save changes';
  }
});

/* ---------------- settings ---------------- */

function keywordRowHtml(term = '', weight = 5) {
  return `<div class="kwrow" style="display:flex;gap:8px;margin-bottom:8px;align-items:center">
    <input class="kw-term" value="${esc(term)}" placeholder="keyword" style="flex:2;padding:9px 11px;border:1px solid var(--line);border-radius:4px">
    <input class="kw-weight" type="number" min="0" value="${weight}" style="width:70px;padding:9px 11px;border:1px solid var(--line);border-radius:4px">
    <button type="button" class="btn ghost sm kw-remove">Remove</button>
  </div>`;
}
$('#keywordRows').addEventListener('click', (e) => {
  if (e.target.classList.contains('kw-remove')) e.target.closest('.kwrow').remove();
});
$('#addKeywordBtn').addEventListener('click', () => {
  $('#keywordRows').insertAdjacentHTML('beforeend', keywordRowHtml());
});

function openSettings(settings) {
  const f = $('#settingsForm');
  f.elements.applicationSlug.value = settings.applicationSlug;
  f.elements.atsThreshold.value = settings.atsThreshold;
  f.elements.interviewRoleTitle.value = settings.interviewRoleTitle;
  f.elements.interviewLinkDays.value = settings.interviewLinkDays;
  f.elements.faceMatchThreshold.value = settings.faceMatchThreshold;
  f.elements.adminNotifyEmail.value = settings.adminNotifyEmail || '';
  f.elements.autoSendOnSubmit.checked = !!settings.autoSendOnSubmit;
  f.elements.rejectionSubject.value = settings.rejectionSubject;
  f.elements.rejectionBody.value = settings.rejectionBody;
  $('#keywordRows').innerHTML = (settings.atsKeywords || []).map((k) => keywordRowHtml(k.term, k.weight)).join('') || keywordRowHtml();
  $('#settingsLink').value = `${location.origin}/apply/${settings.applicationSlug}`;
  $('#settingsErr').classList.add('hide');
  $('#settingsBg').classList.remove('hide');
  $('#settingsSheet').classList.remove('hide');
}
const closeSettings = () => { $('#settingsBg').classList.add('hide'); $('#settingsSheet').classList.add('hide'); };
$('#settingsBg').addEventListener('click', closeSettings);
document.querySelectorAll('[data-close-settings]').forEach((b) => b.addEventListener('click', closeSettings));

async function openSettingsFresh() {
  const { settings } = await api('/api/admin/settings');
  APP_SETTINGS = settings;
  openSettings(settings);
}
$('#atsSettingsBtn').addEventListener('click', openSettingsFresh);
$('#applyLinkBtn').addEventListener('click', openSettingsFresh);

$('#copySettingsLink').addEventListener('click', (e) => {
  navigator.clipboard.writeText($('#settingsLink').value);
  e.target.textContent = 'Copied';
  setTimeout(() => (e.target.textContent = 'Copy'), 1400);
});

$('#settingsForm').elements.applicationSlug.addEventListener('input', (e) => {
  $('#settingsLink').value = `${location.origin}/apply/${e.target.value || ''}`;
});

$('#settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');
  const err = $('#settingsErr');
  err.classList.add('hide');
  const f = e.target;
  const atsKeywords = [...document.querySelectorAll('#keywordRows .kwrow')].map((row) => ({
    term: row.querySelector('.kw-term').value.trim(),
    weight: Number(row.querySelector('.kw-weight').value) || 0,
  })).filter((k) => k.term);
  const body = {
    applicationSlug: f.elements.applicationSlug.value.trim(),
    atsKeywords,
    atsThreshold: Number(f.elements.atsThreshold.value),
    interviewRoleTitle: f.elements.interviewRoleTitle.value.trim(),
    interviewLinkDays: Number(f.elements.interviewLinkDays.value),
    faceMatchThreshold: Number(f.elements.faceMatchThreshold.value),
    adminNotifyEmail: f.elements.adminNotifyEmail.value.trim(),
    autoSendOnSubmit: f.elements.autoSendOnSubmit.checked,
    rejectionSubject: f.elements.rejectionSubject.value,
    rejectionBody: f.elements.rejectionBody.value,
  };
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const { settings } = await api('/api/admin/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    APP_SETTINGS = settings;
    closeSettings();
    if (!$('#paneApplications').classList.contains('hide')) loadApplications();
  } catch (e2) {
    err.textContent = e2.message; err.classList.remove('hide');
  } finally {
    btn.disabled = false; btn.textContent = 'Save settings';
  }
});

boot();
