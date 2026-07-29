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
  return `<tr>
    <td class="name-cell"><b>${esc(c.name)}</b><span>${esc(c.email || c.id)}</span></td>
    <td>${esc(c.role)}</td>
    <td><span class="pill ${c.status}">${STATUS[c.status]}</span></td>
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
    ${c.hasVerification ? `
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

  const flags = c.violations.length ? `<div class="card" style="border-color:#e6c4bf">
    <h3 style="color:var(--record)">Integrity flags</h3>
    <ul class="plain">${c.violations.map((v) => `<li><span class="mono">${fmtDate(v.at)}</span> — ${esc(v.type)}${v.detail ? `: ${esc(v.detail)}` : ''} (at question ${v.atQuestion})</li>`).join('')}</ul>
  </div>` : '';

  const evidence = (c.evidenceShots || []).length ? `<div class="card">
    <h3>Evidence photos</h3>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      ${c.evidenceShots.map((s) => `
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

  return overview + flags + evidence + report + recording + slot1 + slot2;
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

boot();
