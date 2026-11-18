"""Strict validation and canonicalisation of public GitHub repository URLs."""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from urllib.parse import urlsplit

from app.core.errors import InvalidRepositoryUrl

# GitHub owner: 1-39 chars, alphanumeric or single hyphens, cannot start/end with hyphen.
_OWNER_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$")
# Repository name: letters, digits, '.', '-', '_' (max 100). '.' and '..' are rejected separately.
_REPO_RE = re.compile(r"^[A-Za-z0-9._-]{1,100}$")
_ALLOWED_HOSTS = {"github.com", "www.github.com"}
_MAX_URL_LEN = 300


@dataclass(frozen=True)
class GitHubRepoRef:
    owner: str
    name: str

    @property
    def canonical_url(self) -> str:
        return f"https://github.com/{self.owner}/{self.name}"

    @property
    def clone_url(self) -> str:
        return f"https://github.com/{self.owner}/{self.name}.git"

    @property
    def slug(self) -> str:
        return f"{self.owner}/{self.name}"


def parse_github_url(raw: str) -> GitHubRepoRef:
    """Validate ``raw`` and return a canonical reference or raise InvalidRepositoryUrl.

    Accepts only ``https://github.com/<owner>/<repo>`` with an optional ``.git`` suffix
    and optional trailing slash. Everything else (other schemes, hosts, ports,
    credentials, query strings, fragments, deeper paths) is rejected.
    """
    if not isinstance(raw, str):
        raise InvalidRepositoryUrl("URL must be a string")
    value = raw.strip()
    if not value:
        raise InvalidRepositoryUrl("URL is empty")
    if len(value) > _MAX_URL_LEN:
        raise InvalidRepositoryUrl("URL is too long")
    if any(unicodedata.category(c).startswith("C") or c.isspace() for c in value):
        raise InvalidRepositoryUrl("URL contains whitespace or control characters")
    if not value.isascii():
        raise InvalidRepositoryUrl("URL must be ASCII")
    if "\\" in value or "%" in value:
        raise InvalidRepositoryUrl("URL contains disallowed characters")

    try:
        parts = urlsplit(value)
    except ValueError as exc:
        raise InvalidRepositoryUrl("Malformed URL") from exc

    if parts.scheme.lower() != "https":
        raise InvalidRepositoryUrl("Only https:// URLs are supported")
    if "@" in parts.netloc or parts.username is not None or parts.password is not None:
        raise InvalidRepositoryUrl("URLs with embedded credentials are not allowed")
    try:
        port = parts.port
    except ValueError as exc:
        raise InvalidRepositoryUrl("Invalid port") from exc
    if port is not None:
        raise InvalidRepositoryUrl("Explicit ports are not allowed")
    host = (parts.hostname or "").lower()
    if host not in _ALLOWED_HOSTS:
        raise InvalidRepositoryUrl("Only github.com repositories are supported")
    if parts.query or parts.fragment or value.endswith(("?", "#")):
        raise InvalidRepositoryUrl("Query strings and fragments are not allowed")

    path = parts.path
    if path.endswith("/"):
        path = path[:-1]
    segments = path.split("/")
    # leading "" from the initial slash
    if len(segments) != 3 or segments[0] != "":
        raise InvalidRepositoryUrl("URL must point at a repository root: https://github.com/<owner>/<repo>")
    owner, name = segments[1], segments[2]
    if name.endswith(".git"):
        name = name[: -len(".git")]
    if not _OWNER_RE.match(owner):
        raise InvalidRepositoryUrl("Invalid repository owner")
    if not _REPO_RE.match(name) or name in {".", ".."} or (name.startswith(".") and set(name) == {"."}):
        raise InvalidRepositoryUrl("Invalid repository name")
    if ".." in name:
        raise InvalidRepositoryUrl("Invalid repository name")
    return GitHubRepoRef(owner=owner, name=name)
