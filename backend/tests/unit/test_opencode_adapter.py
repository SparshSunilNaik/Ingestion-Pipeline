import json

import httpx
import pytest

from app.agents.opencode_adapter import DENY_ALL_PERMISSIONS, OpenCodeAdapter
from app.core.errors import AgentError, AgentUnavailable

MODELS = {
    "location": {"directory": "x"},
    "data": [
        {
            "id": "gpt-5.6-terra",
            "modelID": "gpt-5.6-terra",
            "providerID": "openai",
            "name": "GPT-5.6 Terra",
            "family": "gpt-terra",
            "status": "active",
            "enabled": True,
            "headers": {"chatgpt-account-id": "SECRET-ACCOUNT"},
            "settings": {"baseURL": "https://x"},
            "limit": {"context": 400000, "output": 128000},
            "variants": [{"id": "low"}, {"id": "high"}],
        },
        {"id": "gpt-5.6-terra-fast", "modelID": "gpt-5.6-terra", "providerID": "openai", "name": "GPT-5.6 Terra Fast", "enabled": True},
        {"id": "off", "providerID": "openai", "name": "Disabled", "enabled": False},
    ],
}


class Recorder:
    def __init__(self, handler) -> None:
        self.requests: list[httpx.Request] = []
        self.handler = handler

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self.handler(request)


def make(handler) -> tuple[OpenCodeAdapter, Recorder]:
    rec = Recorder(handler)
    return OpenCodeAdapter("http://127.0.0.1:1", "opencode", "pw", transport=httpx.MockTransport(rec)), rec


def ok_handler(request: httpx.Request) -> httpx.Response:
    if request.url.path == "/api/info":
        return httpx.Response(200, json={"version": "2.0.29", "pid": 1, "urls": [], "paths": {"tmp": "x"}})
    if request.url.path == "/api/model":
        return httpx.Response(200, json=MODELS)
    if request.url.path == "/api/experimental/generate":
        return httpx.Response(200, json={"data": {"text": "PONG"}})
    if request.url.path == "/api/session" and request.method == "POST":
        return httpx.Response(200, json={"data": {"id": "ses_abc123"}})
    if request.url.path.endswith("/interrupt"):
        return httpx.Response(200, json={"data": {"interrupted": True}})
    if request.method == "DELETE":
        return httpx.Response(204)
    return httpx.Response(404, json={"_tag": "NotFound", "message": "nope"})


def test_runtime_info_and_basic_auth() -> None:
    a, rec = make(ok_handler)
    info = a.runtime_info()
    assert info.available and info.version == "2.0.29"
    assert rec.requests[0].headers["authorization"].startswith("Basic ")


def test_models_are_sanitized() -> None:
    a, _ = make(ok_handler)
    models = a.list_models()
    assert [m.id for m in models] == ["openai/gpt-5.6-terra", "openai/gpt-5.6-terra-fast", "openai/off"]
    terra = models[0]
    assert terra.context_limit == 400000 and terra.variants == ["low", "high"]
    assert "SECRET-ACCOUNT" not in json.dumps([m.__dict__ for m in models])


def test_resolve_model_never_substitutes() -> None:
    a, _ = make(ok_handler)
    assert a.resolve_model("openai/gpt-5.6-terra").name == "GPT-5.6 Terra"
    with pytest.raises(AgentUnavailable) as e:
        a.resolve_model("openai/gpt-5.6-terra-ultra")
    assert e.value.details["kind"] == "model_not_found"
    with pytest.raises(AgentUnavailable):
        a.resolve_model("openai/off")
    with pytest.raises(AgentError):
        a.resolve_model("no-provider")


def test_generate_payload() -> None:
    a, rec = make(ok_handler)
    res = a.generate("hello", "openai/gpt-5.6-terra", variant="low")
    assert res.text == "PONG" and res.prompt_chars == 5
    body = json.loads(rec.requests[0].content)
    assert body == {"prompt": "hello", "model": {"providerID": "openai", "id": "gpt-5.6-terra", "variant": "low"}}


def test_session_lifecycle_uses_deny_all_permissions() -> None:
    a, rec = make(ok_handler)
    sid = a.create_session("t", "openai/gpt-5.6-terra", "C:/sandbox")
    assert sid == "ses_abc123"
    body = json.loads(rec.requests[0].content)
    assert body["permissions"] == DENY_ALL_PERMISSIONS
    assert a.interrupt_session(sid) is True
    a.delete_session(sid)
    with pytest.raises(AgentError):
        a.delete_session("../../api/config")


@pytest.mark.parametrize(
    ("status", "body", "exc", "kind"),
    [
        (401, {"_tag": "UnauthorizedError", "message": "Authentication required"}, AgentUnavailable, "unauthorized"),
        (503, {"_tag": "ServiceUnavailableError", "message": "down"}, AgentUnavailable, "service_unavailable"),
        (400, {"_tag": "InvalidRequestError", "message": "bad"}, AgentError, "invalid_request"),
        (404, {"_tag": "LocationNotFoundError", "message": "x"}, AgentError, "not_found"),
        (500, {}, AgentError, "upstream_error"),
    ],
)
def test_error_normalization(status, body, exc, kind) -> None:
    a, _ = make(lambda r: httpx.Response(status, json=body))
    with pytest.raises(exc) as e:
        a.generate("x", "openai/m")
    assert e.value.details["kind"] == kind


def test_timeout_and_connection_errors() -> None:
    def timeout(_):
        raise httpx.ReadTimeout("slow")

    a, _ = make(timeout)
    with pytest.raises(AgentUnavailable) as e:
        a.generate("x", "openai/m")
    assert e.value.details["kind"] == "timeout"

    def refused(_):
        raise httpx.ConnectError("refused")

    a, _ = make(refused)
    info = a.runtime_info()
    assert not info.available and "Cannot connect" in (info.error or "")


def test_endpoint_allowlist_blocks_everything_else() -> None:
    a, rec = make(ok_handler)
    for method, path in [
        ("POST", "/api/session/ses_1/shell"),
        ("POST", "/api/pty"),
        ("POST", "/api/experimental/fs/write"),
        ("GET", "/api/fs/read/x"),
        ("PATCH", "/api/experimental/config"),
    ]:
        with pytest.raises(AgentError):
            a._request(method, path)
    assert rec.requests == []


def test_cancel_stops_further_requests() -> None:
    a, rec = make(ok_handler)
    a.cancel()
    with pytest.raises(AgentError) as e:
        a.generate("x", "openai/m")
    assert e.value.details["kind"] == "cancelled"
    assert rec.requests == []
