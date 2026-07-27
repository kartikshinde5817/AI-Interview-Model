@echo off
REM Optional launcher. Uncomment and fill in to enable AI questions and scoring.
REM set ANTHROPIC_API_KEY=sk-ant-...
REM set SESSION_SECRET=some-long-random-string

REM Optional: uncomment and fill in to have invitation emails actually sent.
REM set SMTP_HOST=mail.jsntechmark.com
REM set SMTP_PORT=465
REM set SMTP_USER=priti.mahakale@jsntechmark.com
REM set SMTP_PASS=the-email-account-password
REM set SMTP_FROM=priti.mahakale@jsntechmark.com

python main.py
