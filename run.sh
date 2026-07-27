#!/bin/bash
# Optional launcher. Uncomment and fill in to enable AI questions and scoring.
# export ANTHROPIC_API_KEY=sk-ant-...
# export SESSION_SECRET=some-long-random-string

# Optional: uncomment and fill in to have invitation emails actually sent.
export SMTP_HOST=mail.jsntechmark.com
export SMTP_PORT=465
export SMTP_USER=priti.mahakale@jsntechmark.com
export SMTP_PASS=Jsn*@2026
export SMTP_FROM=priti.mahakale@jsntechmark.com   # optional, defaults to SMTP_USER

python3 main.py
