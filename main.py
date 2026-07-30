#!/usr/bin/env python3
"""
AI Interview Console
====================
One file, one command:

    pip install -r requirements.txt
    python main.py

It serves the dashboard, the public job application form, the candidate exam
runtime and the whole API from a single process on http://localhost:8000

  Admin panel      admin / admin123
  Candidate panel  user  / user123

Set ANTHROPIC_API_KEY to have questions written and answers scored by Claude.
Without it the platform runs on a built-in question bank with the same mix.

The admin-editable public application form (/apply/<slug>) collects candidate
details and a resume, scores the resume against admin-configured ATS keywords,
and automatically emails an interview invite or a rejection based on the score.
"""

import base64
import hashlib
import hmac
import io
import json
import mimetypes
import os
import random
import re
import secrets
import shutil
import smtplib
import socket
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import parseaddr
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from cryptography.fernet import Fernet, InvalidToken

# Some hosts (e.g. Railway) resolve outbound hostnames to IPv6 addresses but
# have no IPv6 egress route, which fails raw-socket protocols like SMTP with
# "Network is unreachable" while HTTPS keeps working. Force IPv4 resolution
# process-wide so smtplib (and everything else) connects over IPv4 instead.
_orig_getaddrinfo = socket.getaddrinfo


def _ipv4_only_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
    return _orig_getaddrinfo(host, port, socket.AF_INET, type, proto, flags)


socket.getaddrinfo = _ipv4_only_getaddrinfo
from urllib.parse import urlsplit, unquote, parse_qs

BASE = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(BASE, "public")
DATA = os.path.join(BASE, "data")
UPLOADS = os.path.join(DATA, "uploads")
RECORDINGS = os.path.join(DATA, "recordings")
VERIFICATIONS = os.path.join(DATA, "verifications")
EVIDENCE = os.path.join(DATA, "evidence")
PHOTOS = os.path.join(DATA, "photos")
DB_FILE = os.path.join(DATA, "db.json")

MAX_UPLOAD_BYTES = 8 * 1024 * 1024  # applies to the public, unauthenticated /api/apply endpoint
RESUME_EXTS = (".pdf", ".doc", ".docx", ".txt", ".md")
PHOTO_EXTS = (".jpg", ".jpeg", ".png")


def env(key, default):
    v = os.environ.get(key)
    return v if v not in (None, "") else default


def env_int(key, default):
    try:
        return int(env(key, default))
    except (TypeError, ValueError):
        return default


CFG = {
    "port": env_int("PORT", 8000),
    "host": env("HOST", "0.0.0.0"),
    "session_secret": env("SESSION_SECRET", "change-this-session-secret"),
    "admin_user": env("ADMIN_USER", "admin"),
    "admin_pass": env("ADMIN_PASS", "admin123"),
    "candidate_user": env("CANDIDATE_USER", "user"),
    "candidate_pass": env("CANDIDATE_PASS", "user123"),
    "slot1_time_sec": env_int("SLOT1_TIME_SEC", env_int("TOTAL_TIME_SEC", 20 * 60)),
    "q_time_interview": env_int("Q_TIME_INTERVIEW", 120),
    "q_time_reasoning": env_int("Q_TIME_REASONING", 45),
    "n_interview": env_int("N_INTERVIEW", 15),
    "n_math": env_int("N_MATH", 3),
    "n_analytical": env_int("N_ANALYTICAL", 4),
    "n_puzzle": env_int("N_PUZZLE", 3),
    "n_game": env_int("N_GAME", 2),
    "q_time_game": env_int("Q_TIME_GAME", 30),
    "game_tiles": 4,
    "strict_proctor": env("STRICT_PROCTOR", "true").lower() != "false",
    "pass_score": env_int("PASS_SCORE", 50),
    "anthropic_key": env("ANTHROPIC_API_KEY", ""),
    "anthropic_model": env("ANTHROPIC_MODEL", "claude-sonnet-5"),
    "smtp_host": env("SMTP_HOST", ""),
    "smtp_port": env_int("SMTP_PORT", 587),
    "smtp_user": env("SMTP_USER", ""),
    "smtp_pass": env("SMTP_PASS", ""),
    "smtp_from": env("SMTP_FROM", ""),
    "resend_api_key": env("RESEND_API_KEY", ""),
    "resend_from": env("RESEND_FROM", "AI Interview Console <onboarding@resend.dev>"),
    "brevo_api_key": env("BREVO_API_KEY", ""),
    "brevo_from": env("BREVO_FROM", ""),
}

for d in (DATA, UPLOADS, RECORDINGS, VERIFICATIONS, EVIDENCE, PHOTOS):
    os.makedirs(d, exist_ok=True)


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def new_id(n=6):
    return secrets.token_hex(n)


# --------------------------------------------------------------------------- #
# Storage                                                                      #
# --------------------------------------------------------------------------- #

_lock = threading.RLock()
_state = {"candidates": [], "applications": [], "settings": {}}

SETTINGS_DEFAULTS = {
    "applicationSlug": None,   # filled in on first boot below
    "atsKeywords": [
        {"term": "python", "weight": 5}, {"term": "javascript", "weight": 5},
        {"term": "sql", "weight": 4}, {"term": "communication", "weight": 3},
    ],
    "atsThreshold": 60,
    "interviewRoleTitle": "Open position",
    "autoSendOnSubmit": False,
    "rejectionSubject": "Your application update - {{role}}",
    "rejectionBody": (
        "Hi {{name}},\n\n"
        "Thank you for taking the time to apply for the {{role}} position and for sharing your "
        "resume with us. After careful review, we will not be moving forward with your "
        "application at this time.\n\n"
        "This decision reflects the specific needs of this role rather than your overall "
        "potential, and we encourage you to apply again in the future.\n\n"
        "We wish you the very best in your job search.\n\n"
        "Warm regards,\nThe Hiring Team"
    ),
}


def migrate_settings(s):
    for key, default in SETTINGS_DEFAULTS.items():
        s.setdefault(key, [] if isinstance(default, list) else default)
    if not s.get("applicationSlug"):
        s["applicationSlug"] = new_id(4)
    return s

CANDIDATE_DEFAULTS = {
    "slot1DeadlineAt": None, "verificationPhoto": None, "evidenceShots": [],
    "recording": None, "recordingBytes": 0, "violations": [], "cursor": 0,
    "report": None, "generatedBy": None, "notes": "", "resumeText": "", "resumeFile": None,
    "scheduleStart": None, "scheduleEnd": None, "username": None, "password": None,
}

_USERNAME_ADJ = ["swift", "bright", "calm", "keen", "bold", "quiet", "quick", "sharp", "clear", "steady"]
_USERNAME_NOUN = ["falcon", "maple", "river", "comet", "cedar", "harbor", "willow", "granite", "meadow", "ember"]
_PASSWORD_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"


def gen_username():
    return f"{secrets.choice(_USERNAME_ADJ)}-{secrets.choice(_USERNAME_NOUN)}-{secrets.randbelow(900) + 100}"


def gen_password(n=10):
    return "".join(secrets.choice(_PASSWORD_CHARS) for _ in range(n))


def migrate_candidate(c):
    """Backfill fields added in later versions so old db.json records stay loadable."""
    for key, default in CANDIDATE_DEFAULTS.items():
        c.setdefault(key, [] if isinstance(default, list) else default)
    c.setdefault("deadlineAt", None)
    if c.get("slot1DeadlineAt") is None and c.get("deadlineAt"):
        c["slot1DeadlineAt"] = c["deadlineAt"]
    return c


APPLICATION_DEFAULTS = {
    "candidateId": None, "emailSent": None, "emailMessage": None, "decisionAt": None,
    "atsMatches": [], "atsCriteriaSnapshot": None,
}


def migrate_application(a):
    for key, default in APPLICATION_DEFAULTS.items():
        a.setdefault(key, [] if isinstance(default, list) else default)
    return a


if os.path.exists(DB_FILE):
    try:
        with open(DB_FILE, encoding="utf-8") as f:
            _state = json.load(f)
        _state.setdefault("candidates", [])
        _state.setdefault("applications", [])
        _state.setdefault("settings", {})
        _state["candidates"] = [migrate_candidate(c) for c in _state["candidates"]]
        _state["applications"] = [migrate_application(a) for a in _state["applications"]]
        _state["settings"] = migrate_settings(_state["settings"])
    except Exception as exc:  # noqa: BLE001
        print(f"  ! db.json unreadable ({exc}), starting fresh")
        _state = {"candidates": [], "applications": [], "settings": migrate_settings({})}
else:
    _state["settings"] = migrate_settings(_state["settings"])


def save():
    with _lock:
        tmp = DB_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(_state, f, indent=2)
        os.replace(tmp, DB_FILE)


def all_candidates():
    return _state["candidates"]


def find_candidate(cid):
    return next((c for c in _state["candidates"] if c["id"] == cid), None)


def find_by_token(token):
    return next((c for c in _state["candidates"] if c["token"] == token), None)


def create_candidate(**kw):
    c = {
        "id": new_id(6),
        "token": new_id(16),
        "name": kw.get("name", ""),
        "email": kw.get("email", ""),
        "role": kw.get("role", ""),
        "experience": kw.get("experience", ""),
        "notes": kw.get("notes", ""),
        "resumeText": kw.get("resumeText", ""),
        "resumeFile": kw.get("resumeFile"),
        "status": "invited",            # invited | in_progress | completed | terminated
        "createdAt": now_iso(),
        "scheduleStart": kw.get("scheduleStart") or None,
        "scheduleEnd": kw.get("scheduleEnd") or None,
        "startedAt": None,
        "finishedAt": None,
        "slot1DeadlineAt": None,
        "questions": [],
        "answers": [],
        "violations": [],
        "cursor": 0,
        "recording": None,
        "recordingBytes": 0,
        "verificationPhoto": None,
        "evidenceShots": [],
        "report": None,
        "generatedBy": None,
        "username": gen_username(),
        "password": gen_password(),
    }
    with _lock:
        _state["candidates"].insert(0, c)
    save()
    return c


def get_settings():
    return _state["settings"]


def update_settings(**kw):
    with _lock:
        _state["settings"].update(kw)
    save()
    return _state["settings"]


def all_applications():
    return _state["applications"]


def find_application(aid):
    return next((a for a in _state["applications"] if a["id"] == aid), None)


def create_application(**kw):
    a = {
        "id": new_id(6),
        "createdAt": now_iso(),
        "name": kw.get("name", ""),
        "mobile": kw.get("mobile", ""),
        "email": kw.get("email", ""),
        "aadhaarEnc": kw.get("aadhaarEnc"),
        "aadhaarLast4": kw.get("aadhaarLast4", ""),
        "photoFile": kw.get("photoFile"),
        "resumeFile": kw.get("resumeFile"),
        "resumeText": kw.get("resumeText", ""),
        "atsScore": kw.get("atsScore", 0),
        "atsMatches": kw.get("atsMatches", []),
        "atsCriteriaSnapshot": kw.get("atsCriteriaSnapshot"),
        "status": "submitted",   # submitted | invited | rejected
        "decisionAt": None,
        "emailSent": None,
        "emailMessage": None,
        "candidateId": None,
    }
    with _lock:
        _state["applications"].insert(0, a)
    save()
    return a


def delete_application(aid):
    with _lock:
        a = find_application(aid)
        if not a:
            return False
        _state["applications"].remove(a)
    for path in (
        os.path.join(UPLOADS, a["resumeFile"]) if a.get("resumeFile") else None,
        os.path.join(PHOTOS, a["photoFile"]) if a.get("photoFile") else None,
    ):
        if path and os.path.exists(path):
            try:
                os.remove(path)
            except OSError:
                pass
    save()
    return True


def schedule_error(c):
    """None if the interview link is currently within its scheduled window, else an error message."""
    now = datetime.now()
    start = c.get("scheduleStart")
    end = c.get("scheduleEnd")
    try:
        if start and now < datetime.fromisoformat(start):
            return f"This interview link is not active yet. It opens on {fmt_schedule(start)}."
        if end and now > datetime.fromisoformat(end):
            return f"This interview link expired on {fmt_schedule(end)}. Contact the hiring team for a new one."
    except ValueError:
        pass
    return None


def esc_html(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;").replace("'", "&#39;"))


def fmt_schedule(iso_str):
    if not iso_str:
        return None
    try:
        return datetime.fromisoformat(iso_str).strftime("%d %b %Y, %I:%M %p")
    except ValueError:
        return iso_str


# --------------------------------------------------------------------------- #
# Resume parsing, ATS scoring, Aadhaar encryption                              #
# --------------------------------------------------------------------------- #

def extract_resume_text(filepath, ext):
    """Best-effort text extraction; never raises - a failed parse just yields no text."""
    ext = ext.lower()
    try:
        if ext in (".txt", ".md"):
            with open(filepath, "rb") as f:
                return f.read().decode("utf-8", "replace")
        if ext == ".pdf":
            from pypdf import PdfReader
            reader = PdfReader(filepath)
            return "\n".join(page.extract_text() or "" for page in reader.pages)
        if ext == ".docx":
            from docx import Document
            doc = Document(filepath)
            return "\n".join(p.text for p in doc.paragraphs)
    except Exception as exc:  # noqa: BLE001
        print(f"  ! resume text extraction failed ({filepath}): {exc}")
    return ""


def score_resume(text, criteria):
    """Rule-based ATS score: percentage of configured keyword weight found in the resume text."""
    text_l = (text or "").lower()
    keywords = criteria.get("atsKeywords") or []
    matches = [kw for kw in keywords if kw.get("term") and kw["term"].lower() in text_l]
    total_weight = sum(max(0, kw.get("weight", 0)) for kw in keywords)
    matched_weight = sum(max(0, kw.get("weight", 0)) for kw in matches)
    score = round(matched_weight / total_weight * 100) if total_weight else 0
    return score, matches


def _fernet():
    key = base64.urlsafe_b64encode(hashlib.sha256(CFG["session_secret"].encode()).digest())
    return Fernet(key)


def encrypt_aadhaar(raw):
    return _fernet().encrypt(raw.encode()).decode()


def decrypt_aadhaar(token):
    if not token:
        return ""
    try:
        return _fernet().decrypt(token.encode()).decode()
    except InvalidToken:
        return ""


def build_invitation_content(c, base_url):
    link = f"{base_url}/i/{c['token']}"
    login_user = c.get("username") or CFG["candidate_user"]
    login_pass = c.get("password") or CFG["candidate_pass"]
    start_txt = fmt_schedule(c.get("scheduleStart"))
    end_txt = fmt_schedule(c.get("scheduleEnd"))
    if start_txt and end_txt:
        note = f"You are only allowed to take this interview between {start_txt} and {end_txt}. The link will not work outside that window."
    elif start_txt:
        note = f"You are allowed to take this interview starting {start_txt}. The link will not work before that."
    elif end_txt:
        note = f"You are allowed to take this interview any time up to {end_txt}. The link will not work after that."
    else:
        note = "This link is active as soon as you receive it."

    text_body = f"""Hi {c['name']},

You have been invited to an AI-assisted interview for the {c['role']} position.

Interview link: {link}
Sign-in username: {login_user}
Sign-in password: {login_pass}

Note: {note}

Before you begin, make sure you are on a laptop or desktop with a working camera and microphone,
in a quiet, well-lit room, with about 40 minutes free.

Good luck!
"""
    html_body = f"""\
<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#12161c;max-width:520px">
  <p>Hi {esc_html(c['name'])},</p>
  <p>You have been invited to an AI-assisted interview for the <b>{esc_html(c['role'])}</b> position.</p>
  <p style="margin:22px 0">
    <a href="{esc_html(link)}" style="background:#0e7a61;color:#fff;text-decoration:none;padding:11px 20px;border-radius:5px;display:inline-block">Open your interview</a>
  </p>
  <p style="font-size:13px;color:#626b75">Or copy this link: <a href="{esc_html(link)}">{esc_html(link)}</a></p>
  <p>Sign-in username: <b>{esc_html(login_user)}</b><br>Sign-in password: <b>{esc_html(login_pass)}</b></p>
  <p style="background:#f8efd9;border-left:3px solid #b07d16;padding:10px 14px;margin:18px 0">
    <b>Note:</b> {esc_html(note)}
  </p>
  <p>Before you begin, make sure you are on a laptop or desktop with a working camera and microphone,
  in a quiet, well-lit room, with about 40 minutes free.</p>
  <p>Good luck!</p>
</div>"""
    subject = f"Your interview invitation - {c['role']}"
    return subject, text_body, html_body


def send_via_resend(to_email, to_name, subject, text_body, html_body):
    """HTTP-based send. Works on hosts (e.g. Railway) that block outbound SMTP ports,
    since it's just an HTTPS POST like the Claude API calls."""
    body = json.dumps({
        "from": CFG["resend_from"],
        "to": [to_email],
        "subject": subject,
        "text": text_body,
        "html": html_body,
    }).encode()
    req = urllib.request.Request(
        "https://api.resend.com/emails",
        data=body,
        headers={
            "content-type": "application/json",
            "authorization": f"Bearer {CFG['resend_api_key']}",
            # Resend sits behind Cloudflare, which rejects the default
            # "Python-urllib/x.y" agent with a 403 (error code 1010).
            "user-agent": "InterviewConsole/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as res:
            data = json.loads(res.read().decode())
        return True, f"sent to {to_email} via Resend (id {data.get('id', '?')})"
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        return False, f"Resend rejected the request ({exc.code}): {detail[:300]}"
    except Exception as exc:  # noqa: BLE001
        return False, str(exc)


def send_via_brevo(to_email, to_name, subject, text_body, html_body):
    """HTTP-based send, like send_via_resend. Brevo will send from a single
    sender address verified by clicking a link in that mailbox, so it needs no
    DNS records - the option to reach for when you cannot edit the domain's zone."""
    name, addr = parseaddr(CFG["brevo_from"])
    if not addr:
        return False, "BREVO_FROM is missing or malformed (expected: Name <you@example.com>)"
    body = json.dumps({
        "sender": {"name": name or addr, "email": addr},
        "to": [{"email": to_email, "name": to_name or to_email}],
        "subject": subject,
        "textContent": text_body,
        "htmlContent": html_body,
    }).encode()
    req = urllib.request.Request(
        "https://api.brevo.com/v3/smtp/email",
        data=body,
        headers={
            "content-type": "application/json",
            "accept": "application/json",
            "api-key": CFG["brevo_api_key"],
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as res:
            data = json.loads(res.read().decode())
        return True, f"sent to {to_email} via Brevo (id {data.get('messageId', '?')})"
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        return False, f"Brevo rejected the request ({exc.code}): {detail[:300]}"
    except Exception as exc:  # noqa: BLE001
        return False, str(exc)


def send_via_smtp(to_email, to_name, subject, text_body, html_body):
    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = CFG["smtp_from"] or CFG["smtp_user"]
    msg["To"] = to_email
    msg.attach(MIMEText(text_body, "plain"))
    msg.attach(MIMEText(html_body, "html"))
    try:
        # Port 465 is implicit SSL/TLS from the first byte; anything else (587, 25, ...)
        # connects in plain text and then upgrades with STARTTLS.
        if CFG["smtp_port"] == 465:
            with smtplib.SMTP_SSL(CFG["smtp_host"], CFG["smtp_port"], timeout=15) as s:
                s.login(CFG["smtp_user"], CFG["smtp_pass"])
                s.sendmail(msg["From"], [to_email], msg.as_string())
        else:
            with smtplib.SMTP(CFG["smtp_host"], CFG["smtp_port"], timeout=15) as s:
                s.starttls()
                s.login(CFG["smtp_user"], CFG["smtp_pass"])
                s.sendmail(msg["From"], [to_email], msg.as_string())
        return True, f"sent to {to_email}"
    except Exception as exc:  # noqa: BLE001
        return False, str(exc)


def send_email(to_email, to_name, subject, text_body, html_body):
    """Generic dispatcher shared by interview invitations and application decision
    emails. Picks whichever provider is configured, Brevo -> Resend -> SMTP."""
    if not to_email:
        return False, "no email on file"
    if CFG["brevo_api_key"]:
        return send_via_brevo(to_email, to_name, subject, text_body, html_body)
    if CFG["resend_api_key"]:
        return send_via_resend(to_email, to_name, subject, text_body, html_body)
    if CFG["smtp_host"] and CFG["smtp_user"] and CFG["smtp_pass"]:
        return send_via_smtp(to_email, to_name, subject, text_body, html_body)
    return False, ("No email provider configured "
                   "(set BREVO_API_KEY, or RESEND_API_KEY, or SMTP_HOST / SMTP_USER / SMTP_PASS)")


def send_invitation_email(c, base_url):
    """Sent synchronously, right when the candidate profile is created, so the
    admin knows immediately whether it actually went out. Returns (ok, message)."""
    if not c.get("email"):
        return False, "no email on file"
    subject, text_body, html_body = build_invitation_content(c, base_url)
    return send_email(c["email"], c.get("name"), subject, text_body, html_body)


def build_rejection_content(a, settings):
    role = settings.get("interviewRoleTitle") or "this position"
    subject = settings["rejectionSubject"].replace("{{name}}", a["name"]).replace("{{role}}", role)
    text_body = settings["rejectionBody"].replace("{{name}}", a["name"]).replace("{{role}}", role)
    html_body = f'<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#12161c;max-width:520px;white-space:pre-wrap">{esc_html(text_body)}</div>'
    return subject, text_body, html_body


def send_rejection_email(a):
    if not a.get("email"):
        return False, "no email on file"
    subject, text_body, html_body = build_rejection_content(a, get_settings())
    return send_email(a["email"], a.get("name"), subject, text_body, html_body)


def process_application(a, base_url):
    """Automatic decision: score vs. threshold decides which email goes out.
    Runs either from the admin's 'Process' click or automatically at submission
    time when settings.autoSendOnSubmit is on."""
    settings = get_settings()
    if a["atsScore"] >= settings["atsThreshold"]:
        c = create_candidate(
            name=a["name"], email=a["email"], role=settings["interviewRoleTitle"],
            resumeText=a["resumeText"], resumeFile=a["resumeFile"],
        )
        ok, msg = send_invitation_email(c, base_url)
        a["candidateId"] = c["id"]
        a["status"] = "invited"
    else:
        ok, msg = send_rejection_email(a)
        a["status"] = "rejected"
    a["emailSent"] = ok
    a["emailMessage"] = msg
    a["decisionAt"] = now_iso()
    save()
    return a


def delete_candidate(cid):
    with _lock:
        c = find_candidate(cid)
        if not c:
            return False
        _state["candidates"].remove(c)
    for path in (
        os.path.join(UPLOADS, c["resumeFile"]) if c.get("resumeFile") else None,
        os.path.join(RECORDINGS, c["recording"]) if c.get("recording") else None,
        os.path.join(VERIFICATIONS, c["verificationPhoto"]) if c.get("verificationPhoto") else None,
    ):
        if path and os.path.exists(path):
            try:
                os.remove(path)
            except OSError:
                pass
    for shot in c.get("evidenceShots") or []:
        path = os.path.join(EVIDENCE, shot["file"])
        if os.path.exists(path):
            try:
                os.remove(path)
            except OSError:
                pass
    save()
    return True


# --------------------------------------------------------------------------- #
# Sessions (signed cookie, stateless)                                          #
# --------------------------------------------------------------------------- #

def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _unb64(txt: str) -> bytes:
    return base64.urlsafe_b64decode(txt + "=" * (-len(txt) % 4))


def _sign(payload: str) -> str:
    return _b64(hmac.new(CFG["session_secret"].encode(), payload.encode(), hashlib.sha256).digest())


def make_cookie(data: dict, hours=8) -> str:
    data = dict(data, exp=time.time() + hours * 3600)
    payload = _b64(json.dumps(data).encode())
    return f"{payload}.{_sign(payload)}"


def read_cookie(header: str):
    if not header:
        return None
    raw = None
    for part in header.split(";"):
        part = part.strip()
        if part.startswith("sid="):
            raw = part[4:]
    if not raw or "." not in raw:
        return None
    payload, sig = raw.rsplit(".", 1)
    if not hmac.compare_digest(_sign(payload), sig):
        return None
    try:
        data = json.loads(_unb64(payload))
    except Exception:  # noqa: BLE001
        return None
    if data.get("exp", 0) < time.time():
        return None
    return data


# --------------------------------------------------------------------------- #
# Question bank (used when no API key is configured, or if a call fails)       #
# --------------------------------------------------------------------------- #

BANK = {
    "math": [
        {"text": "A shirt sells for 800 after a 20% discount. What was the original price?",
         "options": ["960", "1000", "1024", "1080"], "answerIndex": 1},
        {"text": "What is 15% of 240?", "options": ["30", "32", "36", "40"], "answerIndex": 2},
        {"text": "Find the next number in the series: 2, 6, 12, 20, 30, ?",
         "options": ["36", "40", "42", "44"], "answerIndex": 2},
        {"text": "The average of 5 numbers is 20. If one number equal to 10 is removed, what is the average of the remaining 4?",
         "options": ["21.5", "22.0", "22.5", "25.0"], "answerIndex": 2},
        {"text": "A 120 m long train runs at 72 km/h. How long does it take to pass a stationary pole?",
         "options": ["4 s", "6 s", "8 s", "10 s"], "answerIndex": 1},
    ],
    "analytical": [
        {"text": "Find the missing number in the pattern: 4, 9, 16, 25, ?, 49",
         "options": ["30", "36", "40", "42"], "answerIndex": 1},
        {"text": "Which figure completes the sequence: a shape rotates 90 degrees clockwise each step - square, then diamond, then square again, then?",
         "options": ["Diamond", "Triangle", "Square", "Circle"], "answerIndex": 0},
        {"text": "Find the next term: 3, 6, 11, 18, 27, ?",
         "options": ["36", "38", "40", "44"], "answerIndex": 1},
        {"text": "In a group of 5 people, X sits immediately left of Y, Y sits immediately left of Z, and Z sits immediately left of X. What kind of seating arrangement is this?",
         "options": ["A straight line", "A circular arrangement", "Impossible to determine", "Two separate rows"], "answerIndex": 1},
        {"text": "Three of the following four pairs are alike in a certain way, one is not. Which one does not belong: (2,8), (3,27), (4,64), (5,20)?",
         "options": ["(2,8)", "(3,27)", "(4,64)", "(5,20)"], "answerIndex": 3},
        {"text": "A cube is painted on all six faces and then cut into 27 identical smaller cubes. How many small cubes have exactly two painted faces?",
         "options": ["8", "12", "6", "4"], "answerIndex": 1},
    ],
    "puzzle": [
        {"text": "A farmer has to ferry a fox, a goose, and a bag of grain across a river one at a time, and cannot leave the fox alone with the goose, or the goose alone with the grain. What should he take across first?",
         "options": ["The fox", "The goose", "The grain", "Any of them, order does not matter"], "answerIndex": 1},
        {"text": "You have two ropes, each of which burns unevenly in exactly 60 minutes when lit from one end. Using only these ropes and a lighter, how do you measure exactly 45 minutes?",
         "options": ["Light one rope at both ends", "Light one rope at one end, then the other at both ends after 15 minutes",
                     "Light one rope at both ends and the other at one end at the same time",
                     "It cannot be done with only two ropes"], "answerIndex": 2},
        {"text": "A man is looking at a photo. Someone asks whose photo it is. He replies, \"Brothers and sisters I have none, but this man's father is my father's son.\" Whose photo is it?",
         "options": ["His own son", "His father", "Himself", "His brother"], "answerIndex": 0},
        {"text": "You have 8 identical-looking balls, one of which is slightly heavier. Using a balance scale, what is the minimum number of weighings needed to guarantee finding the heavier ball?",
         "options": ["1", "2", "3", "4"], "answerIndex": 1},
        {"text": "Three switches outside a room control one bulb inside. You may flip switches as much as you like, but may only enter the room once. How do you determine which switch controls the bulb?",
         "options": ["It is impossible with only one entry", "Turn on one switch, wait, turn it off, turn on a second, then enter and check the bulb's state and warmth",
                     "Turn on all three switches at once and enter immediately",
                     "Flip each switch once in sequence while standing outside"], "answerIndex": 1},
        {"text": "A clock's hour and minute hands overlap at 12:00. Approximately how many minutes after 3:00 do the hands next overlap?",
         "options": ["About 15 minutes", "About 16.4 minutes", "About 20 minutes", "About 12 minutes"], "answerIndex": 1},
    ],
}


def fallback_interview(c):
    role = c.get("role") or "the role"
    return [
        f"Please introduce yourself and walk me through your background as it relates to the {role} position.",
        "Walk me through your educational background and how it prepared you for this line of work.",
        "Describe the project on your resume you are most proud of. What was your specific contribution?",
        f"What made you apply for this {role} position, and what do you expect the first three months to look like?",
        "Tell me about a technical or professional skill on your resume that you would call your strongest. How did you build it?",
        "Pick a tool or technology listed on your resume and explain a real situation where you used it to solve a problem.",
        "Describe a problem in your recent work that took you longer than expected. How did you get to a solution?",
        "Tell me about a time you disagreed with a teammate or manager. How was it resolved?",
        f"Which part of the {role} job description do you feel least prepared for, and how would you close that gap?",
        "Describe a time you had to learn something new quickly to finish a task. What did you do?",
        "Tell me about the most complex project on your resume. What made it complex and how did you manage that?",
        "Tell me about a mistake you made at work and what changed in how you work because of it.",
        "Describe a time you had to work with limited resources or a tight deadline. What trade-offs did you make?",
        "How do you keep your skills current in your field, and what have you learned recently?",
        f"Where do you want your career to be in three years, and how does this {role} position fit that?",
    ][: CFG["n_interview"]]


def make_memory_game_question(round_n):
    """A real, playable memory-sequence mini-game rather than a trivia question about games."""
    tiles = CFG["game_tiles"]
    seq_len = 3 + round_n
    return {
        "type": "game", "category": "gaming", "gameKind": "memory",
        "text": f"Memory game - round {round_n}: watch the sequence of tiles light up, then repeat it back in the same order.",
        "tiles": tiles,
        "sequence": [random.randrange(tiles) for _ in range(seq_len)],
        "timeLimit": CFG["q_time_game"],
    }


def make_reorder_game_question(round_n):
    """A second, distinct mini-game: click the numbered tiles back in ascending order."""
    tiles = CFG["game_tiles"] + 1
    layout = list(range(1, tiles + 1))
    random.shuffle(layout)
    answer_order = sorted(range(tiles), key=lambda i: layout[i])
    return {
        "type": "game", "category": "gaming", "gameKind": "reorder",
        "text": f"Number order game - round {round_n}: click the tiles in ascending numeric order, smallest first.",
        "tiles": tiles,
        "layout": layout,
        "answerOrder": answer_order,
        "timeLimit": CFG["q_time_game"],
    }


def make_game_rounds():
    """First n_game rounds are one mini-game, the next n_game rounds are a different one -
    grouped and never interleaved, so each pair is clearly its own game."""
    n = CFG["n_game"]
    memory = [make_memory_game_question(i + 1) for i in range(n)]
    reorder = [make_reorder_game_question(i + 1) for i in range(n)]
    return memory + reorder


def fallback_analytical():
    n = min(CFG["n_analytical"], len(BANK["analytical"]))
    return [dict(q, category="analytical") for q in random.sample(BANK["analytical"], n)]


def fallback_math():
    n = min(CFG["n_math"], len(BANK["math"]))
    return [dict(q, category="math") for q in random.sample(BANK["math"], n)]


def fallback_puzzle():
    n = min(CFG["n_puzzle"], len(BANK["puzzle"]))
    return [dict(q, category="puzzle") for q in random.sample(BANK["puzzle"], n)]


# --------------------------------------------------------------------------- #
# Claude                                                                       #
# --------------------------------------------------------------------------- #

SYSTEM_WRITER = ("You are an experienced technical hiring panel member who writes interview and "
                 "assessment questions. You always reply with valid JSON only. No markdown fences, "
                 "no commentary before or after.")


def call_claude(system, user, max_tokens=4000, timeout=120):
    if not CFG["anthropic_key"]:
        return None
    body = json.dumps({
        "model": CFG["anthropic_model"],
        "max_tokens": max_tokens,
        "system": system,
        "messages": [{"role": "user", "content": user}],
    }).encode()
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=body,
        headers={
            "content-type": "application/json",
            "x-api-key": CFG["anthropic_key"],
            "anthropic-version": "2023-06-01",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as res:
        data = json.loads(res.read().decode())
    return "\n".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")


def parse_json(text):
    if not text:
        return None
    cleaned = text.replace("```json", "").replace("```", "").strip()
    start = min((i for i in (cleaned.find("["), cleaned.find("{")) if i != -1), default=-1)
    if start == -1:
        return None
    end = max(cleaned.rfind("]"), cleaned.rfind("}"))
    try:
        return json.loads(cleaned[start:end + 1])
    except json.JSONDecodeError:
        return None


def candidate_brief(c):
    lines = [f"Candidate name: {c['name']}", f"Position applied for: {c['role']}"]
    if c.get("experience"):
        lines.append(f"Experience level: {c['experience']}")
    if c.get("notes"):
        lines.append(f"Notes from the hiring team: {c['notes']}")
    if c.get("resumeText"):
        lines.append('Resume:\n"""\n' + c["resumeText"][:12000] + '\n"""')
    else:
        lines.append("Resume: (not supplied - write questions from the position alone)")
    return "\n".join(lines)


def ai_interview_questions(c):
    n = CFG["n_interview"]
    user = f"""{candidate_brief(c)}

Write {n} unique, personalized spoken interview questions for this exact candidate. Every question must be
grounded in specific details from the resume below (named skills, employers, tools, degrees, courses or
projects) or the position — do not write generic questions that could apply to any candidate.
Rules:
- Questions 1-2: background, education and motivation, grounded in the resume.
- Questions 3-4: the candidate's educational background, degree, coursework or certifications and how they connect to this role.
- Questions 5-10: dig into specific projects, tools, technologies and claims that appear in the resume, and how they map to the position.
- Questions 11-{n}: role-specific judgement and situational questions for a {c['role']}, informed by the seniority implied by the resume.
- One question at a time, each answerable out loud in under two minutes.
- No multi-part questions, no yes/no questions, no questions the resume already answers.
- No two questions may probe the same skill, project or claim.

Return JSON: {{"questions":[{{"text":"...","focus":"short tag such as resume, education, project, motivation, role"}}]}}"""
    out = parse_json(call_claude(SYSTEM_WRITER, user, 2500))
    items = (out or {}).get("questions")
    if not items or len(items) < 3:
        raise RuntimeError("interview generation returned nothing usable")
    return [{"text": str(q["text"]).strip(), "focus": q.get("focus", "interview")} for q in items[:n]]


def ai_math_questions(c):
    n = CFG["n_math"]
    user = f"""{candidate_brief(c)}

Write {n} quantitative aptitude multiple-choice questions (percentages, averages, ratios, series, speed and
distance), each with exactly 4 options and exactly one correct option.

Rules:
- Every question must be objectively answerable and self-contained.
- Options must be plausible; do not use "all of the above" or "none of the above".
- Keep each question under 45 words.

Return JSON:
{{"questions":[{{"text":"...","options":["a","b","c","d"],"answerIndex":0,"explanation":"one line"}}]}}"""
    out = parse_json(call_claude(SYSTEM_WRITER, user, 3000))
    items = (out or {}).get("questions")
    if not items:
        raise RuntimeError("math generation returned nothing usable")

    def clean(q):
        return {
            "text": str(q["text"]).strip(),
            "options": [str(o) for o in q.get("options", [])][:4],
            "answerIndex": int(q.get("answerIndex", 0)),
            "category": "math",
            "explanation": q.get("explanation", ""),
        }

    out_qs = [q for q in (clean(x) for x in items) if len(q["options"]) == 4][:n]
    if len(out_qs) < n:
        raise RuntimeError("math generation incomplete")
    return out_qs


def ai_analytical_questions(c):
    n = CFG["n_analytical"]
    user = f"""{candidate_brief(c)}

Write {n} multiple-choice analytical ability questions, each with exactly 4 options and exactly one correct option.
Cover a mix of: pattern recognition, logical reasoning, number/letter sequences, and general analytical thinking
(e.g. spatial or figural patterns, series completion, odd-one-out, arrangement puzzles). Do not write quantitative
aptitude, grammar, or role-knowledge questions - this set is purely analytical ability.

Rules:
- Every question must be objectively answerable and self-contained (describe any figure or arrangement in words).
- Options must be plausible; do not use "all of the above" or "none of the above".
- Keep each question under 45 words.
- No two questions may test the same pattern or trick.

Return JSON:
{{"questions":[{{"text":"...","options":["a","b","c","d"],"answerIndex":0,"explanation":"one line"}}]}}"""
    out = parse_json(call_claude(SYSTEM_WRITER, user, 3000))
    items = (out or {}).get("questions")
    if not items:
        raise RuntimeError("analytical generation returned nothing usable")

    def clean(q):
        return {
            "text": str(q["text"]).strip(),
            "options": [str(o) for o in q.get("options", [])][:4],
            "answerIndex": int(q.get("answerIndex", 0)),
            "category": "analytical",
            "explanation": q.get("explanation", ""),
        }

    out_qs = [q for q in (clean(x) for x in items) if len(q["options"]) == 4][:n]
    if len(out_qs) < n:
        raise RuntimeError("analytical generation incomplete")
    return out_qs


def ai_puzzle_questions(c):
    n = CFG["n_puzzle"]
    user = f"""{candidate_brief(c)}

Write {n} multiple-choice puzzle questions, each with exactly 4 options and exactly one correct option.
Use classic brain-teaser / lateral-thinking puzzle formats: river-crossing style constraint puzzles, weighing
puzzles, rope/clock timing puzzles, relationship riddles, switch/light puzzles, or similar. These should be
distinct from plain pattern-sequence or quantitative-aptitude questions - each one should require working
through a small constraint or logic puzzle to reach the answer.

Rules:
- Every question must be fully self-contained and objectively answerable from the text alone.
- Options must be plausible; do not use "all of the above" or "none of the above".
- Keep each question under 60 words.
- No two questions may reuse the same puzzle type or trick.

Return JSON:
{{"questions":[{{"text":"...","options":["a","b","c","d"],"answerIndex":0,"explanation":"one line"}}]}}"""
    out = parse_json(call_claude(SYSTEM_WRITER, user, 3000))
    items = (out or {}).get("questions")
    if not items:
        raise RuntimeError("puzzle generation returned nothing usable")

    def clean(q):
        return {
            "text": str(q["text"]).strip(),
            "options": [str(o) for o in q.get("options", [])][:4],
            "answerIndex": int(q.get("answerIndex", 0)),
            "category": "puzzle",
            "explanation": q.get("explanation", ""),
        }

    out_qs = [q for q in (clean(x) for x in items) if len(q["options"]) == 4][:n]
    if len(out_qs) < n:
        raise RuntimeError("puzzle generation incomplete")
    return out_qs


def build_paper(c):
    source = "ai"
    try:
        if not CFG["anthropic_key"]:
            raise RuntimeError("no api key configured")
        interview = ai_interview_questions(c)
        math_qs = ai_math_questions(c)
        analytical = ai_analytical_questions(c)
        puzzle = ai_puzzle_questions(c)
    except Exception as exc:  # noqa: BLE001
        print(f"  [ai] falling back to question bank: {exc}")
        source = "fallback-after-error" if CFG["anthropic_key"] else "fallback-no-key"
        interview = [{"text": t, "focus": "interview"} for t in fallback_interview(c)]
        math_qs = fallback_math()
        analytical = fallback_analytical()
        puzzle = fallback_puzzle()

    games = make_game_rounds()

    questions = []
    for i, q in enumerate(interview):
        questions.append({
            "id": new_id(3), "slot": 1, "slotName": "Interview", "n": i + 1,
            "type": "open", "category": q.get("focus", "interview"), "text": q["text"],
            "timeLimit": CFG["q_time_interview"],
        })
    n = 0
    for q in games:
        n += 1
        item = {
            "id": new_id(3), "slot": 2, "slotName": "Reasoning", "n": n,
            "type": "game", "category": q["category"], "text": q["text"],
            "gameKind": q["gameKind"], "tiles": q["tiles"], "timeLimit": q["timeLimit"],
        }
        if q["gameKind"] == "reorder":
            item["layout"] = q["layout"]
            item["answerOrder"] = q["answerOrder"]
        else:
            item["sequence"] = q["sequence"]
        questions.append(item)
    for q in analytical + puzzle + math_qs:
        n += 1
        questions.append({
            "id": new_id(3), "slot": 2, "slotName": "Reasoning", "n": n,
            "type": "mcq", "category": q["category"], "text": q["text"],
            "options": q["options"], "answerIndex": q["answerIndex"],
            "explanation": q.get("explanation", ""), "timeLimit": CFG["q_time_reasoning"],
        })
    return questions, source


def objective_score(c):
    by_cat, correct, total = {}, 0, 0
    for q in c["questions"]:
        if q["type"] not in ("mcq", "game"):
            continue
        total += 1
        a = next((x for x in c["answers"] if x["questionId"] == q["id"]), None)
        if q["type"] == "mcq":
            ok = bool(a and a.get("choice") is not None and int(a["choice"]) == int(q["answerIndex"]))
        elif q.get("gameKind") == "reorder":
            ok = bool(a and a.get("sequence") == q["answerOrder"])
        else:
            ok = bool(a and a.get("sequence") == q["sequence"])
        correct += 1 if ok else 0
        cat = by_cat.setdefault(q["category"], {"correct": 0, "total": 0})
        cat["total"] += 1
        cat["correct"] += 1 if ok else 0
    return {"correct": correct, "total": total, "byCategory": by_cat}


def evaluate(c):
    objective = objective_score(c)
    open_qs = []
    for q in c["questions"]:
        if q["type"] != "open":
            continue
        a = next((x for x in c["answers"] if x["questionId"] == q["id"]), None)
        open_qs.append({"n": q["n"], "question": q["text"], "answer": (a or {}).get("text") or "(no answer given)"})

    ai = None
    if CFG["anthropic_key"]:
        try:
            transcript = "\n\n".join(f"Q{o['n']}: {o['question']}\nA{o['n']}: {o['answer']}" for o in open_qs)
            resume = f'Resume:\n"""\n{c["resumeText"][:8000]}\n"""' if c.get("resumeText") else ""
            user = f"""Position: {c['role']}
Candidate: {c['name']}
{resume}

Spoken interview transcript (typed answers, {len(open_qs)} questions):
{transcript}

Objective assessment: {objective['correct']} correct out of {objective['total']}.
Per category: {json.dumps(objective['byCategory'])}

Score each spoken answer from 0 to 10 on relevance, specificity and evidence. Then write a hiring summary.
Be fair and concrete. Short or empty answers score low. Do not invent facts that are not in the answers.

Return JSON:
{{"perQuestion":[{{"n":1,"score":7,"comment":"one sentence"}}],
 "communication":0-10,"technical":0-10,"roleFit":0-10,
 "strengths":["..."],"concerns":["..."],
 "summary":"3-4 sentences","recommendation":"strong hire|hire|maybe|no hire"}}"""
            ai = parse_json(call_claude(
                "You are a careful, evidence-based interview assessor. Reply with valid JSON only.", user, 3000))
        except Exception as exc:  # noqa: BLE001
            print(f"  [ai] evaluation failed: {exc}")

    per_q = (ai or {}).get("perQuestion") or []
    open_avg = round(sum(float(x.get("score", 0)) for x in per_q) / len(per_q), 1) if per_q else None
    objective_pct = (objective["correct"] / objective["total"] * 100) if objective["total"] else 0
    overall = round(objective_pct) if open_avg is None else round(open_avg * 10 * 0.5 + objective_pct * 0.5)

    return {
        "generatedAt": now_iso(),
        "aiAssisted": bool(ai),
        "objective": objective,
        "objectivePct": round(objective_pct),
        "openAvg": open_avg,
        "overall": overall,
        "perQuestion": per_q,
        "communication": (ai or {}).get("communication"),
        "technical": (ai or {}).get("technical"),
        "roleFit": (ai or {}).get("roleFit"),
        "strengths": (ai or {}).get("strengths") or [],
        "concerns": (ai or {}).get("concerns") or [],
        "summary": (ai or {}).get("summary") or
                   ("Objective section scored automatically. Spoken answers need manual review: "
                    "set ANTHROPIC_API_KEY to enable written assessment."),
        "recommendation": (ai or {}).get("recommendation") or "manual review",
    }


def finalise(c, status):
    """Close the attempt now; score it on a background thread so nothing hangs."""
    c["status"] = status
    c["finishedAt"] = now_iso()
    save()

    def work():
        try:
            c["report"] = evaluate(c)
        except Exception as exc:  # noqa: BLE001
            print(f"  [eval] {exc}")
        save()

    threading.Thread(target=work, daemon=True).start()


# --------------------------------------------------------------------------- #
# HTTP helpers                                                                 #
# --------------------------------------------------------------------------- #

def parse_multipart(body: bytes, content_type: str):
    m = re.search(r'boundary=(?:"([^"]+)"|([^;]+))', content_type)
    if not m:
        return {}, {}
    boundary = (m.group(1) or m.group(2)).strip().encode()
    fields, files = {}, {}
    for part in body.split(b"--" + boundary):
        part = part.lstrip(b"\r\n")
        if not part or part.startswith(b"--"):
            continue
        head, _, payload = part.partition(b"\r\n\r\n")
        if payload.endswith(b"\r\n"):
            payload = payload[:-2]
        headers = head.decode("utf-8", "replace")
        name = re.search(r'name="([^"]*)"', headers)
        if not name:
            continue
        filename = re.search(r'filename="([^"]*)"', headers)
        if filename:
            if filename.group(1):
                files[name.group(1)] = (filename.group(1), payload)
        else:
            fields[name.group(1)] = payload.decode("utf-8", "replace")
    return fields, files


def public_view(c):
    return {
        "id": c["id"], "name": c["name"], "email": c["email"], "role": c["role"],
        "experience": c["experience"], "status": c["status"], "createdAt": c["createdAt"],
        "scheduleStart": c.get("scheduleStart"), "scheduleEnd": c.get("scheduleEnd"),
        "startedAt": c["startedAt"], "finishedAt": c["finishedAt"], "token": c["token"],
        "answered": len(c["answers"]), "totalQuestions": len(c["questions"]),
        "violations": len(c["violations"]), "hasRecording": bool(c["recording"]),
        "overall": (c["report"] or {}).get("overall"),
        "recommendation": (c["report"] or {}).get("recommendation"),
    }


def application_view(a, full=False):
    """Aadhaar is always masked here - only /reveal-aadhaar returns the plaintext."""
    out = {
        "id": a["id"], "createdAt": a["createdAt"], "name": a["name"], "mobile": a["mobile"],
        "email": a["email"], "aadhaarMasked": f"XXXX XXXX {a['aadhaarLast4']}" if a["aadhaarLast4"] else "",
        "hasPhoto": bool(a["photoFile"]), "hasResume": bool(a["resumeFile"]),
        "atsScore": a["atsScore"], "status": a["status"], "candidateId": a["candidateId"],
        "emailSent": a["emailSent"], "emailMessage": a["emailMessage"], "decisionAt": a["decisionAt"],
    }
    if full:
        out.update({"atsMatches": a["atsMatches"], "resumeText": a["resumeText"]})
    return out


def slot1_len(c):
    return sum(1 for q in c["questions"] if q["slot"] == 1)


def in_slot1(c):
    return c["cursor"] < slot1_len(c)


def slot1_remaining_sec(c):
    if not c.get("slot1DeadlineAt"):
        return CFG["slot1_time_sec"]
    deadline = datetime.fromisoformat(c["slot1DeadlineAt"])
    return max(0, round((deadline - datetime.now(timezone.utc)).total_seconds()))


def skip_remaining_slot1(c):
    """Slot 1's own clock ran out - fast-forward past any unanswered slot 1 questions into slot 2."""
    n1 = slot1_len(c)
    changed = False
    while c["cursor"] < n1:
        q = c["questions"][c["cursor"]]
        c["answers"].append({
            "questionId": q["id"], "slot": q["slot"], "n": q["n"], "category": q["category"],
            "text": "", "choice": None, "correct": None, "timeSpentSec": 0,
            "skipped": True, "at": now_iso(),
        })
        c["cursor"] += 1
        changed = True
    if changed:
        save()
    return changed


def strip_question(q):
    if not q:
        return None
    out = {k: q[k] for k in ("id", "slot", "slotName", "n", "type", "category", "text", "timeLimit")}
    if q["type"] == "mcq":
        out["options"] = q["options"]          # answerIndex is never sent to the candidate
    if q["type"] == "game":
        out["tiles"] = q["tiles"]
        out["gameKind"] = q.get("gameKind", "memory")
        if out["gameKind"] == "reorder":
            out["layout"] = q["layout"]        # the layout is the puzzle itself; answerOrder is the hidden key
        else:
            out["sequence"] = q["sequence"]    # the sequence is the puzzle itself, not a hidden answer key
    return out


def progress(c):
    return {
        "slot1": {"done": sum(1 for a in c["answers"] if a["slot"] == 1),
                  "total": sum(1 for q in c["questions"] if q["slot"] == 1)},
        "slot2": {"done": sum(1 for a in c["answers"] if a["slot"] == 2),
                  "total": sum(1 for q in c["questions"] if q["slot"] == 2)},
        "index": c["cursor"], "total": len(c["questions"]),
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "InterviewConsole/1.0"
    protocol_version = "HTTP/1.1"

    # ---------- plumbing ----------

    def log_message(self, fmt, *args):
        if os.environ.get("VERBOSE"):
            super().log_message(fmt, *args)

    def _send(self, status, body=b"", ctype="application/json", extra=None):
        if isinstance(body, str):
            body = body.encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def json(self, obj, status=200, extra=None):
        self._send(status, json.dumps(obj), "application/json", extra)

    def error_json(self, status, message):
        self.json({"error": message}, status)

    def content_length(self):
        try:
            return int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return 0

    def body_bytes(self):
        length = self.content_length()
        return self.rfile.read(length) if length else b""

    def body_json(self):
        try:
            return json.loads(self.body_bytes() or b"{}")
        except json.JSONDecodeError:
            return {}

    def query(self):
        return parse_qs(urlsplit(self.path).query)

    def session(self):
        return read_cookie(self.headers.get("Cookie", ""))

    def require_admin(self):
        s = self.session()
        if not s or s.get("role") != "admin":
            self.error_json(401, "Sign in as an administrator to continue.")
            return None
        return s

    def require_candidate(self, token):
        s = self.session()
        if not s or s.get("role") != "candidate" or s.get("token") != token:
            self.error_json(401, "Sign in with the credentials in your invitation to continue.")
            return None
        c = find_by_token(token)
        if not c:
            self.error_json(404, "This interview link is not valid.")
            return None
        return c

    # ---------- routing ----------

    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def do_DELETE(self):
        self.route("DELETE")

    def do_PATCH(self):
        self.route("PATCH")

    def route(self, method):
        path = unquote(urlsplit(self.path).path)
        try:
            if path.startswith("/api/"):
                return self.api(method, path)
            return self.static(path)
        except BrokenPipeError:
            pass
        except Exception as exc:  # noqa: BLE001
            print(f"  ! {method} {path}: {exc}")
            try:
                self.error_json(500, "Something went wrong on the server.")
            except Exception:  # noqa: BLE001
                pass

    # ---------- api ----------

    def api(self, method, path):
        # --- auth ---
        if path == "/api/auth/login" and method == "POST":
            b = self.body_json()
            user, pw = b.get("username", ""), b.get("password", "")
            if b.get("scope") == "candidate":
                token = b.get("token", "")
                cand = find_by_token(token)
                if not cand:
                    return self.error_json(404, "That interview code is not valid. Check the link in your invitation.")
                exp_user = cand.get("username") or CFG["candidate_user"]
                exp_pass = cand.get("password") or CFG["candidate_pass"]
                if user != exp_user or pw != exp_pass:
                    return self.error_json(401, "Those credentials do not match the invitation.")
                if cand["status"] == "invited":
                    err = schedule_error(cand)
                    if err:
                        return self.error_json(403, err)
                cookie = make_cookie({"role": "candidate", "token": token}, hours=4)
                return self.json({"ok": True, "role": "candidate", "token": token},
                                 extra={"Set-Cookie": f"sid={cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=14400"})
            if user != CFG["admin_user"] or pw != CFG["admin_pass"]:
                return self.error_json(401, "Those credentials do not match an administrator account.")
            cookie = make_cookie({"role": "admin", "user": user})
            return self.json({"ok": True, "role": "admin"},
                             extra={"Set-Cookie": f"sid={cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800"})

        if path == "/api/auth/logout" and method == "POST":
            return self.json({"ok": True}, extra={"Set-Cookie": "sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"})

        if path == "/api/auth/me" and method == "GET":
            return self.json(self.session() or {"role": None})

        # --- admin ---
        if path == "/api/admin/candidates" and method == "GET":
            if not self.require_admin():
                return
            return self.json({
                "candidates": [public_view(c) for c in all_candidates()],
                "config": {"slot1TimeSec": CFG["slot1_time_sec"], "aiEnabled": bool(CFG["anthropic_key"]),
                           "candidateUser": CFG["candidate_user"], "candidatePass": CFG["candidate_pass"]},
            })

        if path == "/api/admin/candidates" and method == "POST":
            if not self.require_admin():
                return
            fields, files = parse_multipart(self.body_bytes(), self.headers.get("Content-Type", ""))
            email = (fields.get("email") or "").strip()
            if not fields.get("name") or not fields.get("role"):
                return self.error_json(400, "Name and position are both required.")
            if not email or "@" not in email:
                return self.error_json(400, "A valid email address is required to send the invitation.")
            schedule_start = (fields.get("scheduleStart") or "").strip() or None
            schedule_end = (fields.get("scheduleEnd") or "").strip() or None
            if schedule_start and schedule_end:
                try:
                    if datetime.fromisoformat(schedule_end) <= datetime.fromisoformat(schedule_start):
                        return self.error_json(400, "The interview end date/time must be after the start.")
                except ValueError:
                    return self.error_json(400, "The interview schedule dates are not valid.")
            stored = None
            resume_text = (fields.get("resumeText") or "").strip()
            if "resume" in files:
                original, blob = files["resume"]
                ext = os.path.splitext(original)[1][:10]
                stored = f"{int(time.time())}-{new_id(3)}{ext}"
                with open(os.path.join(UPLOADS, stored), "wb") as f:
                    f.write(blob)
                if not resume_text and ext.lower() in (".txt", ".md"):
                    resume_text = blob.decode("utf-8", "replace")
            c = create_candidate(
                name=fields["name"].strip(), email=email,
                role=fields["role"].strip(), experience=(fields.get("experience") or "").strip(),
                notes=(fields.get("notes") or "").strip(), resumeText=resume_text, resumeFile=stored,
                scheduleStart=schedule_start, scheduleEnd=schedule_end,
            )
            host = self.headers.get("Host") or f"localhost:{CFG['port']}"
            base_url = f"http://{host}"
            email_ok, email_msg = send_invitation_email(c, base_url)
            print(f"  [mail] {'sent' if email_ok else 'NOT sent'} to {c['email']}: {email_msg}")
            return self.json({"ok": True, "candidate": public_view(c), "username": c["username"], "password": c["password"],
                             "emailSent": email_ok, "emailMessage": email_msg})

        m = re.fullmatch(r"/api/admin/candidates/([0-9a-f]+)", path)
        if m and method == "GET":
            if not self.require_admin():
                return
            c = find_candidate(m.group(1))
            if not c:
                return self.error_json(404, "Candidate not found.")
            return self.json({**public_view(c), "notes": c["notes"], "resumeText": c["resumeText"],
                              "username": c["username"], "password": c["password"],
                              "resumeFile": c["resumeFile"], "generatedBy": c["generatedBy"],
                              "recordingBytes": c["recordingBytes"], "hasVerification": bool(c["verificationPhoto"]),
                              "evidenceShots": c["evidenceShots"],
                              "questions": c["questions"],
                              "answers": c["answers"], "violations": c["violations"], "report": c["report"]})

        if m and method == "DELETE":
            if not self.require_admin():
                return
            return self.json({"ok": delete_candidate(m.group(1))})

        if m and method == "PATCH":
            if not self.require_admin():
                return
            c = find_candidate(m.group(1))
            if not c:
                return self.error_json(404, "Candidate not found.")
            b = self.body_json()
            name = (b.get("name") or "").strip()
            email = (b.get("email") or "").strip()
            role = (b.get("role") or "").strip()
            if not name or not role:
                return self.error_json(400, "Name and position are both required.")
            if not email or "@" not in email:
                return self.error_json(400, "A valid email address is required.")
            schedule_start = (b.get("scheduleStart") or "").strip() or None
            schedule_end = (b.get("scheduleEnd") or "").strip() or None
            if schedule_start and schedule_end:
                try:
                    if datetime.fromisoformat(schedule_end) <= datetime.fromisoformat(schedule_start):
                        return self.error_json(400, "The interview end date/time must be after the start.")
                except ValueError:
                    return self.error_json(400, "The interview schedule dates are not valid.")
            c.update({
                "name": name, "email": email, "role": role,
                "experience": (b.get("experience") or "").strip(),
                "notes": (b.get("notes") or "").strip(),
                "scheduleStart": schedule_start, "scheduleEnd": schedule_end,
            })
            save()
            return self.json({"ok": True, "candidate": public_view(c)})

        m = re.fullmatch(r"/api/admin/candidates/([0-9a-f]+)/reset", path)
        if m and method == "POST":
            if not self.require_admin():
                return
            c = find_candidate(m.group(1))
            if not c:
                return self.error_json(404, "Candidate not found.")
            old_photo = c.get("verificationPhoto")
            old_shots = c.get("evidenceShots") or []
            old_recording = c.get("recording")
            c.update({"status": "invited", "startedAt": None, "finishedAt": None, "slot1DeadlineAt": None,
                      "questions": [], "answers": [], "violations": [], "cursor": 0,
                      "verificationPhoto": None, "evidenceShots": [], "recording": None, "recordingBytes": 0,
                      "report": None})
            save()
            if old_photo:
                try:
                    os.remove(os.path.join(VERIFICATIONS, old_photo))
                except OSError:
                    pass
            for shot in old_shots:
                try:
                    os.remove(os.path.join(EVIDENCE, shot["file"]))
                except OSError:
                    pass
            if old_recording:
                try:
                    os.remove(os.path.join(RECORDINGS, old_recording))
                except OSError:
                    pass
            return self.json({"ok": True, "candidate": public_view(c)})

        m = re.fullmatch(r"/api/admin/candidates/([0-9a-f]+)/resume", path)
        if m and method == "GET":
            if not self.require_admin():
                return
            c = find_candidate(m.group(1))
            if not c or not c["resumeFile"]:
                return self.error_json(404, "No resume on file.")
            return self.send_file(os.path.join(UPLOADS, c["resumeFile"]), download=True)

        m = re.fullmatch(r"/api/admin/candidates/([0-9a-f]+)/recording", path)
        if m and method == "GET":
            if not self.require_admin():
                return
            c = find_candidate(m.group(1))
            if not c or not c["recording"]:
                return self.error_json(404, "No recording on file.")
            return self.send_file(os.path.join(RECORDINGS, c["recording"]), ctype="video/webm", ranges=True)

        m = re.fullmatch(r"/api/admin/candidates/([0-9a-f]+)/verification", path)
        if m and method == "GET":
            if not self.require_admin():
                return
            c = find_candidate(m.group(1))
            if not c or not c["verificationPhoto"]:
                return self.error_json(404, "No verification photo on file.")
            return self.send_file(os.path.join(VERIFICATIONS, c["verificationPhoto"]), ctype="image/jpeg")

        m = re.fullmatch(r"/api/admin/candidates/([0-9a-f]+)/evidence/([\w\-.]+)", path)
        if m and method == "GET":
            if not self.require_admin():
                return
            c = find_candidate(m.group(1))
            if not c or not any(s["file"] == m.group(2) for s in c["evidenceShots"]):
                return self.error_json(404, "No such evidence photo.")
            return self.send_file(os.path.join(EVIDENCE, m.group(2)), ctype="image/jpeg")

        # --- admin: settings ---
        if path == "/api/admin/settings" and method == "GET":
            if not self.require_admin():
                return
            return self.json({"settings": get_settings()})

        if path == "/api/admin/settings" and method == "PATCH":
            if not self.require_admin():
                return
            b = self.body_json()
            s = get_settings()
            slug = (b.get("applicationSlug") or "").strip()
            slug = re.sub(r"[^a-z0-9\-]", "", slug.lower())[:40] or s["applicationSlug"]
            keywords = b.get("atsKeywords")
            if not isinstance(keywords, list):
                keywords = s["atsKeywords"]
            else:
                clean = []
                for kw in keywords:
                    term = str((kw or {}).get("term") or "").strip()
                    if not term:
                        continue
                    try:
                        weight = max(0, int((kw or {}).get("weight") or 0))
                    except (TypeError, ValueError):
                        weight = 0
                    clean.append({"term": term, "weight": weight})
                keywords = clean
            try:
                threshold = max(0, min(100, int(b.get("atsThreshold", s["atsThreshold"]))))
            except (TypeError, ValueError):
                threshold = s["atsThreshold"]
            update_settings(
                applicationSlug=slug, atsKeywords=keywords, atsThreshold=threshold,
                interviewRoleTitle=(b.get("interviewRoleTitle") or s["interviewRoleTitle"]).strip(),
                autoSendOnSubmit=bool(b.get("autoSendOnSubmit")),
                rejectionSubject=(b.get("rejectionSubject") or s["rejectionSubject"]),
                rejectionBody=(b.get("rejectionBody") or s["rejectionBody"]),
            )
            return self.json({"ok": True, "settings": get_settings()})

        # --- admin: applications ---
        if path == "/api/admin/applications" and method == "GET":
            if not self.require_admin():
                return
            q = self.query()
            apps = all_applications()
            status = (q.get("status") or [""])[0]
            search = (q.get("q") or [""])[0].strip().lower()
            min_score = (q.get("minScore") or [""])[0]
            max_score = (q.get("maxScore") or [""])[0]
            if status:
                apps = [a for a in apps if a["status"] == status]
            if search:
                apps = [a for a in apps if search in a["name"].lower() or search in a["email"].lower() or search in a["mobile"].lower()]
            if min_score:
                try:
                    apps = [a for a in apps if a["atsScore"] >= int(min_score)]
                except ValueError:
                    pass
            if max_score:
                try:
                    apps = [a for a in apps if a["atsScore"] <= int(max_score)]
                except ValueError:
                    pass
            return self.json({
                "applications": [application_view(a) for a in apps],
                "settings": get_settings(),
            })

        m = re.fullmatch(r"/api/admin/applications/([0-9a-f]+)", path)
        if m and method == "GET":
            if not self.require_admin():
                return
            a = find_application(m.group(1))
            if not a:
                return self.error_json(404, "Application not found.")
            return self.json(application_view(a, full=True))

        if m and method == "PATCH":
            if not self.require_admin():
                return
            a = find_application(m.group(1))
            if not a:
                return self.error_json(404, "Application not found.")
            b = self.body_json()
            name = (b.get("name") or "").strip()
            email = (b.get("email") or "").strip()
            mobile = (b.get("mobile") or "").strip()
            if not name:
                return self.error_json(400, "Name is required.")
            if not email or "@" not in email:
                return self.error_json(400, "A valid email address is required.")
            status = b.get("status") or a["status"]
            if status not in ("submitted", "invited", "rejected"):
                return self.error_json(400, "Not a valid status.")
            a.update({"name": name, "email": email, "mobile": mobile, "status": status})
            save()
            return self.json({"ok": True, "application": application_view(a)})

        if m and method == "DELETE":
            if not self.require_admin():
                return
            return self.json({"ok": delete_application(m.group(1))})

        m = re.fullmatch(r"/api/admin/applications/([0-9a-f]+)/reveal-aadhaar", path)
        if m and method == "POST":
            if not self.require_admin():
                return
            a = find_application(m.group(1))
            if not a:
                return self.error_json(404, "Application not found.")
            return self.json({"aadhaar": decrypt_aadhaar(a.get("aadhaarEnc"))})

        m = re.fullmatch(r"/api/admin/applications/([0-9a-f]+)/rescan", path)
        if m and method == "POST":
            if not self.require_admin():
                return
            a = find_application(m.group(1))
            if not a:
                return self.error_json(404, "Application not found.")
            settings = get_settings()
            score, matches = score_resume(a["resumeText"], settings)
            a["atsScore"], a["atsMatches"], a["atsCriteriaSnapshot"] = score, matches, settings["atsKeywords"]
            save()
            return self.json({"ok": True, "application": application_view(a, full=True)})

        m = re.fullmatch(r"/api/admin/applications/([0-9a-f]+)/process", path)
        if m and method == "POST":
            if not self.require_admin():
                return
            a = find_application(m.group(1))
            if not a:
                return self.error_json(404, "Application not found.")
            host = self.headers.get("Host") or f"localhost:{CFG['port']}"
            process_application(a, f"http://{host}")
            return self.json({"ok": True, "application": application_view(a, full=True)})

        m = re.fullmatch(r"/api/admin/applications/([0-9a-f]+)/resume", path)
        if m and method == "GET":
            if not self.require_admin():
                return
            a = find_application(m.group(1))
            if not a or not a["resumeFile"]:
                return self.error_json(404, "No resume on file.")
            return self.send_file(os.path.join(UPLOADS, a["resumeFile"]), download=True)

        m = re.fullmatch(r"/api/admin/applications/([0-9a-f]+)/photo", path)
        if m and method == "GET":
            if not self.require_admin():
                return
            a = find_application(m.group(1))
            if not a or not a["photoFile"]:
                return self.error_json(404, "No photo on file.")
            return self.send_file(os.path.join(PHOTOS, a["photoFile"]), ctype="image/jpeg")

        # --- public application form ---
        m = re.fullmatch(r"/api/apply/([a-z0-9\-]+)", path)
        if m and method == "POST":
            return self.submit_application(m.group(1))

        # --- interview ---
        m = re.fullmatch(r"/api/interview/([0-9a-f]+)/(\w+)", path)
        if m:
            return self.interview_api(method, m.group(1), m.group(2))

        return self.error_json(404, "No such endpoint.")

    def submit_application(self, slug):
        settings = get_settings()
        if slug != settings["applicationSlug"]:
            return self.error_json(404, "This application link is no longer active.")
        if self.content_length() > MAX_UPLOAD_BYTES:
            return self.error_json(413, "That upload is too large (max 8 MB total).")
        fields, files = parse_multipart(self.body_bytes(), self.headers.get("Content-Type", ""))

        name = (fields.get("name") or "").strip()
        mobile = re.sub(r"\D", "", fields.get("mobile") or "")
        aadhaar = re.sub(r"\D", "", fields.get("aadhaar") or "")
        email = (fields.get("email") or "").strip()

        if not name:
            return self.error_json(400, "Full name is required.")
        if not re.fullmatch(r"\d{10}", mobile):
            return self.error_json(400, "Enter a valid 10-digit mobile number.")
        if not re.fullmatch(r"\d{12}", aadhaar):
            return self.error_json(400, "Enter a valid 12-digit Aadhaar number.")
        if not email or "@" not in email:
            return self.error_json(400, "Enter a valid email address.")
        if "resume" not in files:
            return self.error_json(400, "A resume file is required.")

        resume_original, resume_blob = files["resume"]
        resume_ext = os.path.splitext(resume_original)[1].lower()
        if resume_ext not in RESUME_EXTS:
            return self.error_json(400, "Resume must be a PDF, DOC, DOCX, TXT or MD file.")
        resume_stored = f"{int(time.time())}-{new_id(3)}{resume_ext}"
        resume_path = os.path.join(UPLOADS, resume_stored)
        with open(resume_path, "wb") as f:
            f.write(resume_blob)

        photo_stored = None
        if "photo" in files:
            photo_original, photo_blob = files["photo"]
            photo_ext = os.path.splitext(photo_original)[1].lower()
            if photo_ext not in PHOTO_EXTS:
                return self.error_json(400, "Photo must be a JPG or PNG file.")
            photo_stored = f"{int(time.time())}-{new_id(3)}{photo_ext}"
            with open(os.path.join(PHOTOS, photo_stored), "wb") as f:
                f.write(photo_blob)

        resume_text = extract_resume_text(resume_path, resume_ext)
        score, matches = score_resume(resume_text, settings)

        a = create_application(
            name=name, mobile=mobile, email=email,
            aadhaarEnc=encrypt_aadhaar(aadhaar), aadhaarLast4=aadhaar[-4:],
            photoFile=photo_stored, resumeFile=resume_stored, resumeText=resume_text,
            atsScore=score, atsMatches=matches, atsCriteriaSnapshot=settings["atsKeywords"],
        )
        if settings["autoSendOnSubmit"]:
            host = self.headers.get("Host") or f"localhost:{CFG['port']}"
            process_application(a, f"http://{host}")
        return self.json({"ok": True, "referenceId": a["id"]})

    def interview_api(self, method, token, action):
        c = self.require_candidate(token)
        if not c:
            return

        if action == "state" and method == "GET":
            if c["status"] == "in_progress" and in_slot1(c) and slot1_remaining_sec(c) == 0:
                skip_remaining_slot1(c)
            if c["status"] == "in_progress" and c["cursor"] >= len(c["questions"]):
                finalise(c, "completed")
            return self.json({
                "name": c["name"], "role": c["role"], "status": c["status"],
                "slot1TimeSec": CFG["slot1_time_sec"],
                "inSlot1": in_slot1(c),
                "slot1RemainingSec": slot1_remaining_sec(c) if c["startedAt"] else CFG["slot1_time_sec"],
                "plan": {"slot1": CFG["n_interview"],
                         "slot2": 2 * CFG["n_game"] + CFG["n_analytical"] + CFG["n_puzzle"] + CFG["n_math"],
                         "qTimeInterview": CFG["q_time_interview"], "qTimeReasoning": CFG["q_time_reasoning"],
                         "nGame": CFG["n_game"], "nAnalytical": CFG["n_analytical"],
                         "nPuzzle": CFG["n_puzzle"], "nMath": CFG["n_math"],
                         "strict": CFG["strict_proctor"]},
                "progress": progress(c),
                "question": strip_question(c["questions"][c["cursor"]]) if c["status"] == "in_progress" and c["cursor"] < len(c["questions"]) else None,
                "violations": c["violations"],
                "hasVerification": bool(c["verificationPhoto"]),
            })

        if action == "verification" and method == "POST":
            if c["status"] not in ("invited", "in_progress"):
                return self.error_json(409, "This interview is already closed.")
            stored = f"{c['id']}-{new_id(3)}.jpg"
            with open(os.path.join(VERIFICATIONS, stored), "wb") as f:
                f.write(self.body_bytes())
            old = c.get("verificationPhoto")
            c["verificationPhoto"] = stored
            save()
            if old:
                try:
                    os.remove(os.path.join(VERIFICATIONS, old))
                except OSError:
                    pass
            return self.json({"ok": True})

        if action == "evidence" and method == "POST":
            if c["status"] != "in_progress":
                return self.json({"ok": True})
            kind = str((self.query().get("type") or ["unknown"])[0])[:40]
            stored = f"{c['id']}-{new_id(3)}.jpg"
            with open(os.path.join(EVIDENCE, stored), "wb") as f:
                f.write(self.body_bytes())
            c["evidenceShots"].append({"file": stored, "type": kind, "at": now_iso(), "atQuestion": c["cursor"] + 1})
            save()
            return self.json({"ok": True})

        if action == "start" and method == "POST":
            if c["status"] in ("completed", "terminated"):
                return self.error_json(409, "This interview is already closed.")
            if not c["verificationPhoto"]:
                return self.error_json(400, "Identity verification photo is required before the interview can start.")
            if c["status"] == "invited":
                try:
                    questions, source = build_paper(c)
                except Exception:  # noqa: BLE001
                    return self.error_json(500, "The question paper could not be prepared. Contact the hiring team.")
                deadline = datetime.now(timezone.utc).timestamp() + CFG["slot1_time_sec"]
                c.update({"questions": questions, "generatedBy": source, "status": "in_progress",
                          "startedAt": now_iso(),
                          "slot1DeadlineAt": datetime.fromtimestamp(deadline, timezone.utc).isoformat(),
                          "cursor": 0})
                save()
            return self.json({"ok": True, "question": strip_question(c["questions"][c["cursor"]]),
                              "slot1RemainingSec": slot1_remaining_sec(c), "inSlot1": in_slot1(c), "progress": progress(c)})

        if action == "answer" and method == "POST":
            if c["status"] != "in_progress":
                return self.error_json(409, "This interview is not active.")
            b = self.body_json()
            if c["cursor"] >= len(c["questions"]):
                return self.error_json(400, "There are no questions left.")
            q = c["questions"][c["cursor"]]
            if q["id"] != b.get("questionId"):
                return self.error_json(400, "That question is no longer the active one.")
            choice = b.get("choice")
            sequence = b.get("sequence")
            seq_submitted = [int(x) for x in sequence] if q["type"] == "game" and isinstance(sequence, list) else None
            c["answers"].append({
                "questionId": q["id"], "slot": q["slot"], "n": q["n"], "category": q["category"],
                "text": (str(b.get("text") or "")[:8000]) if q["type"] == "open" else None,
                "choice": int(choice) if q["type"] == "mcq" and choice is not None else None,
                "sequence": seq_submitted,
                "correct": (
                    (int(choice) == int(q["answerIndex"])) if q["type"] == "mcq" and choice is not None else
                    (seq_submitted == q["answerOrder"]) if q["type"] == "game" and q.get("gameKind") == "reorder" else
                    (seq_submitted == q["sequence"]) if q["type"] == "game" else
                    (False if q["type"] == "mcq" else None)
                ),
                "timeSpentSec": max(0, int(b.get("timeSpentSec") or 0)),
                "skipped": bool(b.get("skipped")),
                "at": now_iso(),
            })
            c["cursor"] += 1
            if in_slot1(c) and slot1_remaining_sec(c) == 0:
                skip_remaining_slot1(c)
            save()
            if c["cursor"] >= len(c["questions"]):
                finalise(c, "completed")
                return self.json({"done": True, "status": "completed"})
            return self.json({"done": False, "question": strip_question(c["questions"][c["cursor"]]),
                              "slot1RemainingSec": slot1_remaining_sec(c), "inSlot1": in_slot1(c), "progress": progress(c)})

        if action == "alert" and method == "POST":
            if c["status"] != "in_progress":
                return self.json({"ok": True})
            b = self.body_json()
            c["violations"].append({
                "type": str(b.get("type") or "unknown")[:60],
                "detail": str(b.get("detail") or "")[:300],
                "at": now_iso(), "atQuestion": c["cursor"] + 1,
            })
            save()
            return self.json({"ok": True, "count": len(c["violations"])})

        if action == "violation" and method == "POST":
            if c["status"] != "in_progress":
                return self.json({"terminated": c["status"] == "terminated"})
            b = self.body_json()
            c["violations"].append({
                "type": str(b.get("type") or "unknown")[:60],
                "detail": str(b.get("detail") or "")[:300],
                "at": now_iso(), "atQuestion": c["cursor"] + 1,
            })
            save()
            if CFG["strict_proctor"]:
                finalise(c, "terminated")
                return self.json({"terminated": True})
            return self.json({"terminated": False, "count": len(c["violations"])})

        if action == "result" and method == "GET":
            if c["status"] == "terminated":
                return self.json({"ready": True, "passed": False, "overall": (c["report"] or {}).get("overall")})
            if c["status"] == "completed":
                if not c["report"]:
                    return self.json({"ready": False})
                overall = c["report"]["overall"]
                return self.json({"ready": True, "passed": overall >= CFG["pass_score"], "overall": overall})
            return self.json({"ready": False})

        if action == "finish" and method == "POST":
            if c["status"] == "in_progress":
                finalise(c, "completed")
            return self.json({"ok": True, "status": c["status"]})

        if action == "recording" and method == "POST":
            if not c["recording"]:
                c["recording"] = f"{c['id']}-{c['token'][:6]}.webm"
            target = os.path.join(RECORDINGS, c["recording"])
            with open(target, "ab") as f:
                f.write(self.body_bytes())
            c["recordingBytes"] = os.path.getsize(target)
            save()
            return self.json({"ok": True, "bytes": c["recordingBytes"]})

        return self.error_json(404, "No such interview action.")

    # ---------- files ----------

    def send_file(self, filepath, ctype=None, download=False, ranges=False):
        if not os.path.exists(filepath):
            return self.error_json(404, "File not found.")
        ctype = ctype or mimetypes.guess_type(filepath)[0] or "application/octet-stream"
        size = os.path.getsize(filepath)
        extra = {}
        if download:
            extra["Content-Disposition"] = f'attachment; filename="{os.path.basename(filepath)}"'

        rng = self.headers.get("Range") if ranges else None
        if rng:
            m = re.match(r"bytes=(\d*)-(\d*)", rng)
            start = int(m.group(1)) if m and m.group(1) else 0
            end = int(m.group(2)) if m and m.group(2) else size - 1
            end = min(end, size - 1)
            length = max(0, end - start + 1)
            self.send_response(206)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(length))
            self.end_headers()
            with open(filepath, "rb") as f:
                f.seek(start)
                shutil.copyfileobj(f, self.wfile, length=65536)
            return

        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(size))
        if ranges:
            self.send_header("Accept-Ranges", "bytes")
        for k, v in extra.items():
            self.send_header(k, v)
        self.end_headers()
        with open(filepath, "rb") as f:
            shutil.copyfileobj(f, self.wfile)

    def static(self, path):
        if path == "/" or path == "/dashboard" or path == "/admin":
            return self.send_page("index.html")
        if re.fullmatch(r"/i/[0-9a-f]+", path):
            return self.send_page("interview.html")
        m = re.fullmatch(r"/apply/([a-z0-9\-]+)", path)
        if m:
            if m.group(1) != get_settings()["applicationSlug"]:
                self._send(404, "This application link is no longer active.", "text/plain")
                return
            return self.send_page("apply.html")
        candidate = os.path.normpath(os.path.join(PUBLIC, path.lstrip("/")))
        if candidate.startswith(PUBLIC) and os.path.isfile(candidate):
            return self.send_file(candidate)
        self._send(404, "Not found", "text/plain")

    def send_page(self, name):
        filepath = os.path.join(PUBLIC, name)
        if not os.path.exists(filepath):
            return self._send(500, f"Missing {name}. Keep main.py next to the public/ folder.", "text/plain")
        with open(filepath, "rb") as f:
            body = f.read()
        self._send(200, body, "text/html; charset=utf-8", {"Cache-Control": "no-cache"})


def main():
    server = ThreadingHTTPServer((CFG["host"], CFG["port"]), Handler)
    url = f"http://localhost:{CFG['port']}"
    ai_state = f"on ({CFG['anthropic_model']})" if CFG["anthropic_key"] else \
        "off - using the built-in question bank. Set ANTHROPIC_API_KEY to enable."
    print(f"""
  AI Interview Console
  --------------------
  Dashboard      {url}
  Admin login    {CFG['admin_user']} / {CFG['admin_pass']}
  Candidate      {CFG['candidate_user']} / {CFG['candidate_pass']}
  AI questions   {ai_state}
  Time budget    Slot 1 (voice): {CFG['slot1_time_sec'] // 60} min total, {CFG['q_time_interview']}s per question · Slot 2 (text): {CFG['q_time_reasoning']}s per question, no overall clock
  Data           {DATA}

  Press Ctrl+C to stop.
""")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Stopping. Everything is saved in data/\n")
        save()
        server.server_close()


if __name__ == "__main__":
    main()
