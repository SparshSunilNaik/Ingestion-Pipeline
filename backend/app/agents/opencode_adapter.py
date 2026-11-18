"""Adapter for the OpenCode v2 HTTP API (verified against OpenCode 2.0.29).

Endpoints used (all others are deliberately unused):
  GET    /api/info                       runtime availability + version
  GET    /api/model                      model discovery
  POST   /api/experimental/generate      stateless, tool-less text generation (the only inference path)
  POST   /api/session                    session creation (deny-all permissions)
  DELETE /api/session/{id}               session deletion
  POST   /api/session/{id}/interrupt     interrupt an active session execution

Security note: the analysis workflow only uses ``/api/experimental/generate``. That
endpoint performs one model generation from a prompt and has no tool access (verified
with a canary-file test, see docs/OPENCODE_INTEGRATION.md). All repository access goes
through the backend's read-only gateway instead.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

import httpx

from app.core.errors import AgentError, AgentUnavailable
from app.core.logging import get_logger

log = get_logger(__name__)

ALLOWED_ENDPOINTS = {
    ("GET", "/api/info"),
    ("GET", "/api/model"),
    ("POST", "/api/experimental/generate"),
    ("POST", "/api/session"),
    ("DELETE", "/api/session/{id}"),
    ("POST", "/api/session/{id}/interrupt"),
}
DENY_ALL_PERMISSIONS = [{"action": "*", "resource": "*", "effect": "deny"}]


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


@dataclass
class ModelInfo:
    id: str  # "<provider>/<model>" as accepted by OpenCode
    provider_id: str
    model_id: str
    name: str
    family: str | None = None
    status: str | None = None
    enabled: bool = True
    context_limit: int | None = None
    output_limit: int | None = None
    variants: list[str] = field(default_factory=list)


@dataclass
class RuntimeInfo:
    available: bool
    version: str | None = None
    base_url: str | None = None
    error: str | None = None


@dataclass
class GenerateResult:
    text: str
    model: str
    latency_ms: int
    prompt_chars: int
    response_chars: int


def split_model_id(model: str) -> tuple[str, str]:
    if "/" not in model:
        raise AgentError(f"Model identifier must look like provider/model, got {model!r}")
    provider, _, model_id = model.partition("/")
    if not provider or not model_id:
        raise AgentError(f"Invalid model identifier {model!r}")
    return provider, model_id


class OpenCodeAdapter:
    def __init__(self, base_url: str, username: str, password: str | None, timeout: float = 180.0, transport: httpx.BaseTransport | None = None) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        auth = httpx.BasicAuth(username, password) if password else None
        self._client = httpx.Client(base_url=self.base_url, auth=auth, timeout=httpx.Timeout(timeout, connect=5.0), transport=transport)
        self._cancelled = False

    def close(self) -> None:
        self._client.close()

    def cancel(self) -> None:
        """Abort in-flight requests by closing the connection pool (client-side cancellation)."""
        self._cancelled = True
        self._client.close()

    # -- low level ---------------------------------------------------------
    def _request(self, method: str, path: str, template: str | None = None, **kwargs: Any) -> httpx.Response:
        if (method, template or path) not in ALLOWED_ENDPOINTS:
            raise AgentError(f"Endpoint not allowed by adapter policy: {method} {template or path}")
        if self._cancelled:
            raise AgentError("Request cancelled", details={"kind": "cancelled"})
        start = time.monotonic()
        try:
            resp = self._client.request(method, path, **kwargs)
        except httpx.TimeoutException as exc:
            raise AgentUnavailable("OpenCode request timed out", details={"kind": "timeout"}) from exc
        except httpx.ConnectError as exc:
            raise AgentUnavailable(f"Cannot connect to OpenCode at {self.base_url}", details={"kind": "connection_error"}) from exc
        except (httpx.HTTPError, RuntimeError) as exc:
            if self._cancelled:
                raise AgentError("Request cancelled", details={"kind": "cancelled"}) from exc
            raise AgentUnavailable(f"OpenCode transport error: {type(exc).__name__}", details={"kind": "transport_error"}) from exc
        log.info("opencode %s %s -> %s in %dms", method, template or path, resp.status_code, int((time.monotonic() - start) * 1000))
        if resp.status_code >= 400:
            raise self._normalize_error(resp)
        return resp

    @staticmethod
    def _normalize_error(resp: httpx.Response) -> Exception:
        try:
            body = resp.json()
        except ValueError:
            body = {}
        tag = body.get("_tag") if isinstance(body, dict) else None
        message = (body.get("message") if isinstance(body, dict) else None) or resp.reason_phrase
        details = {"status": resp.status_code, "tag": tag}
        if resp.status_code == 401:
            return AgentUnavailable("OpenCode rejected the credentials (401)", details={**details, "kind": "unauthorized"})
        if resp.status_code == 503:
            return AgentUnavailable(f"OpenCode service unavailable: {message}", details={**details, "kind": "service_unavailable"})
        if resp.status_code == 404:
            return AgentError(f"OpenCode resource not found: {message}", details={**details, "kind": "not_found"})
        if resp.status_code == 400:
            return AgentError(f"OpenCode rejected the request: {message}", details={**details, "kind": "invalid_request"})
        return AgentError(f"OpenCode error {resp.status_code}: {message}", details={**details, "kind": "upstream_error"})

    # -- runtime -------------------------------------------------------------
    def runtime_info(self) -> RuntimeInfo:
        try:
            data = self._request("GET", "/api/info").json()
        except (AgentUnavailable, AgentError) as exc:
            return RuntimeInfo(available=False, base_url=self.base_url, error=exc.message)
        return RuntimeInfo(available=True, version=str(data.get("version")), base_url=self.base_url)

    def list_models(self) -> list[ModelInfo]:
        data = self._request("GET", "/api/model").json()
        models: list[ModelInfo] = []
        for m in data.get("data", []):
            if not isinstance(m, dict) or not m.get("providerID") or not m.get("id"):
                continue
            limit = _as_dict(m.get("limit"))
            # Only whitelisted, non-secret fields are copied (the raw payload contains account headers).
            models.append(
                ModelInfo(
                    id=f"{m['providerID']}/{m['id']}",
                    provider_id=str(m["providerID"]),
                    model_id=str(m.get("modelID") or m["id"]),
                    name=str(m.get("name") or m["id"]),
                    family=m.get("family"),
                    status=m.get("status"),
                    enabled=bool(m.get("enabled", True)),
                    context_limit=limit.get("context"),
                    output_limit=limit.get("output"),
                    variants=[str(v.get("id")) for v in m.get("variants", []) if isinstance(v, dict) and v.get("id")],
                )
            )
        return models

    def resolve_model(self, model: str) -> ModelInfo:
        """Return the exact model or raise. Never substitutes a different model."""
        split_model_id(model)
        for m in self.list_models():
            if m.id == model:
                if not m.enabled:
                    raise AgentUnavailable(f"Model {model} is disabled in OpenCode", details={"kind": "model_disabled"})
                return m
        raise AgentUnavailable(f"Model {model} is not available in this OpenCode installation", details={"kind": "model_not_found"})

    # -- inference -----------------------------------------------------------
    def generate(self, prompt: str, model: str, variant: str | None = None) -> GenerateResult:
        provider, model_id = split_model_id(model)
        body: dict[str, Any] = {"prompt": prompt, "model": {"providerID": provider, "id": model_id}}
        if variant:
            body["model"]["variant"] = variant
        start = time.monotonic()
        data = self._request("POST", "/api/experimental/generate", json=body).json()
        text = data.get("data", {}).get("text") if isinstance(data, dict) else None
        if not isinstance(text, str):
            raise AgentError("OpenCode returned an unexpected generate payload", details={"kind": "bad_payload"})
        return GenerateResult(text=text, model=model, latency_ms=int((time.monotonic() - start) * 1000), prompt_chars=len(prompt), response_chars=len(text))

    # -- sessions (lifecycle support; not used by the analysis workflow) --------
    def create_session(self, title: str, model: str, directory: str) -> str:
        provider, model_id = split_model_id(model)
        body = {
            "title": title[:200],
            "model": {"providerID": provider, "id": model_id},
            "location": {"directory": directory},
            "permissions": DENY_ALL_PERMISSIONS,
        }
        data = self._request("POST", "/api/session", json=body).json()
        sid = data.get("data", {}).get("id")
        if not isinstance(sid, str) or not sid.startswith("ses"):
            raise AgentError("OpenCode returned an unexpected session payload", details={"kind": "bad_payload"})
        return sid

    def delete_session(self, session_id: str) -> None:
        self._request("DELETE", f"/api/session/{_safe_id(session_id)}", template="/api/session/{id}")

    def interrupt_session(self, session_id: str) -> bool:
        data = self._request("POST", f"/api/session/{_safe_id(session_id)}/interrupt", template="/api/session/{id}/interrupt", json={}).json()
        return bool(data.get("data", {}).get("interrupted")) if isinstance(data, dict) else False


def _safe_id(value: str) -> str:
    if not value.startswith("ses") or not value.replace("_", "").replace("-", "").isalnum():
        raise AgentError("invalid session id")
    return value
