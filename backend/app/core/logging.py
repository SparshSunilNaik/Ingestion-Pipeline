"""Structured logging with secret redaction."""

from __future__ import annotations

import json
import logging
import re
import sys
from datetime import UTC, datetime

_SECRET_PATTERNS = [
    re.compile(r"(?i)(authorization|password|api[_-]?key|token|secret)(\"?\s*[:=]\s*\"?)([^\s\",}]+)"),
    re.compile(r"(?i)(basic|bearer)\s+[A-Za-z0-9+/=._-]{8,}"),
    re.compile(r"https://[^/\s:@]+:[^/\s@]+@"),
]


def redact(text: str) -> str:
    out = _SECRET_PATTERNS[1].sub(lambda m: f"{m.group(1)} [REDACTED]", text)
    out = _SECRET_PATTERNS[0].sub(lambda m: f"{m.group(1)}{m.group(2)}[REDACTED]", out)
    out = _SECRET_PATTERNS[2].sub("https://[REDACTED]@", out)
    return out


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": datetime.now(UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "msg": redact(record.getMessage()),
        }
        extra = getattr(record, "ctx", None)
        if isinstance(extra, dict):
            payload["ctx"] = json.loads(redact(json.dumps(extra, default=str)))
        if record.exc_info:
            payload["exc"] = redact(self.formatException(record.exc_info))
        return json.dumps(payload)


class RedactingFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        base = super().format(record)
        extra = getattr(record, "ctx", None)
        if isinstance(extra, dict):
            base += " " + json.dumps(extra, default=str)
        return redact(base)


def configure_logging(level: str = "INFO", as_json: bool = False) -> None:
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(JsonFormatter() if as_json else RedactingFormatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level.upper())


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)
