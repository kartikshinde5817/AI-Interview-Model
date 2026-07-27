# AI Interview Console

A proctored, two-slot interview platform. One dashboard holds both panels: the admin adds a
candidate and their resume, sends one link, and gets back a transcript, an auto-scored
assessment and the session recording.

Backend and frontend run from **one file, one command, no installs**.

---

## Run it

```bash
python main.py
```

Open **http://localhost:8000**

| Panel | Username | Password |
|---|---|---|
| Administrator | `admin` | `admin123` |
| Candidate | `user` | `user123` |

Python 3.9 or newer. Nothing to `pip install` — the server uses only the standard library.

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
| `SESSION_SECRET` | dev value | **Change before deploying** |
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
