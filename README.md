# AI Interview Console

A proctored, two-slot interview platform. One dashboard holds both panels: the admin adds a
candidate and their resume, sends one link, and gets back a transcript, an auto-scored
assessment and the session recording.

Backend and frontend run from **one file, one command**. A public application form feeds a
rule-based ATS screen that automatically emails candidates an interview link or a rejection.

---

## Run it

```bash
pip install -r requirements.txt
python main.py
```

Open **http://localhost:8000**

| Panel | Username | Password |
|---|---|---|
| Administrator | `admin` | `admin123` |
| Candidate | `user` | `user123` |

Python 3.9 or newer. `requirements.txt` adds PDF/DOCX resume parsing (`pypdf`,
`python-docx`), Aadhaar encryption (`cryptography`) and face matching
(`opencv-python-headless`, `numpy`) — everything else is standard library.

On the first identity check the server downloads two ONNX face models (~37 MB total) into
`data/models/` and caches them. That is the only network fetch; after it, matching runs
entirely offline.

To turn on AI-written questions and AI scoring:

```bash
ANTHROPIC_API_KEY=sk-ant-... python main.py        # macOS / Linux
set ANTHROPIC_API_KEY=sk-ant-... && python main.py  # Windows cmd
```

Without a key everything still works: questions come from a built-in bank with the same
category mix, and the objective section is still scored automatically.

---

## The dashboard

`/` is the single door. Pick a tab:

**Administrator** → the admin console.
- Add a candidate: name, email, position, experience, resume text, resume file, panel notes.
- A unique interview link is generated per candidate: `/i/<code>`.
- The candidate list shows status, progress, score and integrity flags, refreshing every 20 seconds.
- Opening a record shows the transcript with per-question scores, the objective breakdown by
  category, every integrity flag with its timestamp, and the session recording.
- **Reset attempt** clears an attempt and issues a fresh link. **Delete** removes everything.

**Candidate** → paste the invitation link (or just the code at the end of it), sign in with
`user` / `user123`, and the interview opens. Candidates who click the link directly land on
the same sign-in without needing the code.

---

## Job applications

Inside the admin panel, the **Applications** tab holds everything for the public-facing
hiring funnel:

- **Application link** — a single public form at `/apply/<slug>`. Anyone with the link can
  submit Name, Mobile Number, Aadhaar Number, Email, Photo and Resume (PDF/DOC/DOCX/TXT/MD,
  8 MB max). The slug is editable from **ATS & email settings** — changing it immediately
  invalidates the old link.
- **ATS scoring** — rule-based: the resume text is checked against an admin-editable list of
  keywords, each with a weight. The score is the percentage of configured weight matched.
  PDF and DOCX resumes are parsed automatically (`pypdf` / `python-docx`).
- **Review** — search/filter applications by name, email, mobile, status or score range. Each
  record shows the photo, a masked Aadhaar number (`XXXX XXXX 1234`, with an explicit
  **Reveal** action), the resume download, and the ATS score with matched keywords.
- **Automatic decision emails** — clicking **Process** on a record compares its ATS score to
  the configured pass threshold: at or above, an interview candidate is created and the
  invitation email fires; below, an editable rejection email is sent instead.
  Turning on **auto-send** in settings fires this the instant someone applies, with no click
  needed.
- **Editable from the dashboard**: the application link/slug, the ATS keyword list and
  threshold, the position title used on auto-created interview invites, how many days the
  interview link stays valid, and the rejection email subject/body (supports `{{name}}` and
  `{{role}}` placeholders).

Aadhaar numbers are encrypted at rest and never returned by the list or detail endpoints —
only the dedicated reveal action (admin session required) decrypts one on demand.

### Shortlisted → interview

A shortlisted applicant's interview link **expires 3 days after they are shortlisted**
(configurable in settings). Once expired the link stops working at sign-in, not just at start.

The invitation email spells out, before the candidate begins:

- the exact expiry date and time of their link,
- that they must have their **original Aadhaar card** with them, type its 12-digit number
  (checked against their application, five attempts) and photograph themselves holding it,
- and every proctoring rule — one device and one screen only, no second person or second
  voice, no switching windows or tabs or leaving full screen, copy/paste disabled, and camera
  and microphone recorded throughout — along with what happens when each is broken.

At the start of the interview the candidate must therefore pass two identity gates before any
question is shown: the Aadhaar number check and the live verification photo.

### Face recognition

The live interview photo is matched against the photo submitted with the application, using
OpenCV's YuNet face detector and SFace recogniser. The two faces become embeddings, and their
cosine similarity is the confidence score. In testing, the same person across different
captures scores 0.93–1.00 while different people score 0.14–0.23, against a default
threshold of **0.363** (SFace's own recommended cut-off, editable in settings).

Three outcomes:

| Result | Score | What happens |
|---|---|---|
| **Face matched** | at or above threshold | Interview proceeds. |
| **Identity verification failed** | clearly below threshold | Interview is **blocked**, an integrity flag is logged, and the hiring team is emailed immediately. The candidate gets 3 attempts in total, then the attempt locks. |
| **Needs manual review** | borderline, or no face detectable, or models unavailable | Interview proceeds, but the record is flagged prominently for a human to check. |

So if someone who did not submit the application form tries to sit the interview, they cannot
get past the photo step — and you find out by email while it is happening.

Saved into the candidate's interview record for review: the verification status, the confidence
score and the threshold it was judged against, the timestamp of the check, the number of
attempts used, and both photo filenames. The **Identity check against application** card in the
candidate record shows the application photo and the live interview photo side by side with the
verdict, the Aadhaar match result, and a **Re-run face match** button (a pass on re-run clears a
lock). Failed candidates are badged **ID failed** in the candidate list, and **Reset attempt**
clears all identity state so a genuine candidate can start over.

Set where alerts go with the `adminNotifyEmail` setting in the dashboard, or the `ADMIN_EMAIL`
environment variable.

### Live face monitoring during the interview

Passing the photo check is not the end of it. Once the interview is running, a camera frame is
sent to the server every 12 seconds and put through the same recogniser, compared against the
registered photo. Four verdicts:

| Verdict | Meaning |
|---|---|
| `ok` | The registered candidate is on camera, alone. Frame is discarded. |
| `no_face` | Nobody is visible — the candidate has left the frame. |
| `multiple_faces` | More than one person is in shot. |
| `different_person` | Someone is there, but it is not the registered candidate. |

A problem must appear on **two consecutive checks** before it costs a strike, so glancing away
for a moment is not punished. Each strike shows the candidate an immediate on-screen warning
("Another person is visible in the camera. You must be alone. Warning 2 of 3") and records the
event with its timestamp, the question number, the face count, the similarity score and a
**screenshot of that exact moment**. Three strikes ends the interview as a fail, matching what
the invitation email tells candidates.

Because the comparison runs on the server, it cannot be switched off by tampering with the page,
and it works in every browser — the previous version relied on a Chrome-only face detector that
could only count faces, never tell *who* they were.

The candidate record gets a **Live face monitoring** card showing each event as a thumbnail with
its verdict, time, score and strike number, so you can see exactly what the camera saw.

### Microphone check

The candidate is shown a sentence — **chosen by the server**, so the transcript can be checked
against the sentence actually given rather than one the page claims to have shown. They must:

1. read that sentence aloud (≥70% of its words recognised), **and**
2. have the reading captured as an audio recording that uploads successfully.

Only when the server has stored a non-empty recording *and* accepted the transcript does
**Continue** unlock. A silent or muted microphone, an empty recording, or reading the wrong
words all keep it disabled, with a message saying which of those went wrong. The recording is
kept and is playable in the admin panel next to the sentence given and the words heard — so you
can confirm the microphone genuinely worked rather than trusting a transcript.

### Nothing starts until all three pass

`/start` refuses on the server unless the Aadhaar number is verified, a verification photo
exists and its face check did not fail, and the microphone check is complete. These are enforced
server-side, so the button being clickable in the page is never what decides it.

Candidates added by hand rather than through the application form have no Aadhaar and no
registered photo on file, so they skip both gates and keep the original photo-only verification.

### Microphone check

The candidate is shown a sentence and must read **that sentence** aloud before the interview can
be started. **Continue** stays disabled until speech recognition returns at least 70% of the
sentence's words (so 8 of 11 on a typical one) — the live count is shown as they read, e.g.
"6 of 11 words matched". Nothing else unlocks it: not a timeout, not background noise, not
saying a few unrelated words. Words are counted only as often as the sentence uses them, so
repeating a single word cannot game the score.

Because the reading cannot be verified without speech recognition — and Slot 1 needs it to
capture spoken answers anyway — browsers without it (Safari, Firefox) are stopped at this step
and told to reopen the link in Chrome or Edge, rather than being let through into an interview
they cannot complete.

---

## The interview

1. **Guidelines page** — the full rulebook, the time plan, and a camera and microphone check.
2. Pressing **Start interview** enters full screen, starts recording and starts the clock.

**Slot 1 — Interview.** 10 spoken questions written from the resume and the position.
The candidate types the answer, or uses the dictation button to speak it (Chrome/Edge).

**Slot 2 — Reasoning.** 20 multiple-choice questions:
- 10 general: 2 game/puzzle, 2 quantitative, 3 English grammar, 3 logical reasoning
- 10 on the role applied for

Each question has its own countdown. **Next question** submits early and banks the time.
When a question's window runs out it submits automatically and moves on. No going back,
no editing a submitted answer.

**Scoring.** Multiple choice is marked automatically. Spoken answers are scored 0–10 each on
relevance, specificity and evidence, with a written summary and a hire recommendation.
The overall score weights the two halves equally. Scoring runs in the background, so the
candidate never waits on it — the report appears in the admin panel a few seconds later.

---

## Proctoring

Enforced automatically once the interview starts:

| Event | Result |
|---|---|
| Tab hidden / another window or app opened | Interview ends |
| Window loses focus | Interview ends |
| Full screen exited | Interview ends |
| Page closed or reloaded | Interview ends |
| Copy, cut, paste, right-click, `Ctrl`/`Cmd` shortcuts, `F12` | Blocked |
| Camera or microphone denied | Cannot start |
| Candidate leaves the camera frame | Warning, then ends on the 3rd strike |
| A second person appears on camera | Warning, then ends on the 3rd strike |
| A different person replaces the candidate | Warning, then ends on the 3rd strike |

Every event is written to the candidate record with a timestamp and the question number it
happened on. An ended interview is submitted as it stands and cannot be restarted by the
candidate — only an admin can reset it.

Camera and microphone record continuously and upload in 8-second chunks, so a terminated
session still leaves a usable recording.

**What browser proctoring cannot do:** it cannot see a second monitor, a phone, or another
person in the room. It detects that *this* window lost focus. Treat flags as signal for a
human reviewer, not proof.

---

## Configuration

Every setting is an environment variable — no file to edit.

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8000` | |
| `HOST` | `0.0.0.0` | |
| `ADMIN_USER` / `ADMIN_PASS` | `admin` / `admin123` | Admin panel |
| `CANDIDATE_USER` / `CANDIDATE_PASS` | `user` / `user123` | Candidate panel |
| `SESSION_SECRET` | dev value | **Change before deploying** — also derives the Aadhaar encryption key |
| `ADMIN_EMAIL` | — | Fallback recipient for identity-failure alerts |
| `TOTAL_TIME_SEC` | `1200` | Hard cap across both slots |
| `Q_TIME_INTERVIEW` | `120` | Seconds per Slot 1 question |
| `Q_TIME_REASONING` | `45` | Seconds per Slot 2 question |
| `N_INTERVIEW` / `N_ROLE` | `10` / `10` | Question counts |
| `STRICT_PROCTOR` | `true` | `false` records flags without ending the interview |
| `ANTHROPIC_API_KEY` | — | Enables AI questions and AI scoring |
| `ANTHROPIC_MODEL` | `claude-sonnet-5` | |
| `VERBOSE` | — | Set to anything for request logging |

### One thing to decide about the clock

The spec asks for a 20-minute total and a 2-minute window per question. Both cannot hold:
30 questions at up to 2 minutes each is 60 minutes of question time.

The 20-minute cap wins in code — when it expires, whatever has been answered is submitted.
A candidate who uses the full 2 minutes on every Slot 1 question will hit the cap before
reaching Slot 2. Pick one:

- **Keep 20 minutes**, shorten the windows:
  `Q_TIME_INTERVIEW=60 Q_TIME_REASONING=30 python main.py` (exactly 20 minutes if every window is used in full)
- **Keep 2-minute windows**, raise the cap:
  `TOTAL_TIME_SEC=2100 python main.py` (35 minutes)

Shipped default is the 20-minute cap with 120s/45s windows — comfortable for candidates who
answer briskly, tight for candidates who use every second.

---

## Before real candidates use it

1. **Change the passwords and `SESSION_SECRET`.** `admin123` and `user123` are demo
   credentials. The two roles are properly separated — a candidate session cannot reach any
   admin endpoint, and admin credentials are rejected on the candidate panel — but anyone who
   knows `admin123` gets the whole console.
2. **Serve over HTTPS.** Browsers only grant camera and microphone access on `https://` or
   `localhost`. Behind a proxy, add `Secure` to the cookie in `main.py`.
3. **Tell candidates they are recorded**, and store recordings in line with your local data
   protection obligations. `data/` holds resumes, transcripts and video as plain files.
4. **Back up `data/`.** Everything lives there: `db.json`, `uploads/`, `recordings/`.
   Past a few hundred candidates, move to Postgres and object storage.
5. Resume **PDF and DOCX uploads are stored for download but not read as text.** Paste the
   resume text in the form for the sharpest questions. `.txt` and `.md` uploads are read.

---

## Layout

```
main.py                      the whole backend: routing, sessions, uploads,
                             question generation, scoring, static files
public/
  index.html                 dashboard: one login, both panels
  interview.html             proctored exam runtime
  assets/dashboard.js        admin console + candidate sign-in
  assets/interview.js        exam flow, recording, proctoring
  assets/app.css             shared styles
data/                        created on first run
  db.json  uploads/  recordings/
```
