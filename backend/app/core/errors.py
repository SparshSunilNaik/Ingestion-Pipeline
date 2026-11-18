"""Domain errors and their HTTP mapping."""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.core.logging import get_logger

log = get_logger(__name__)


class AppError(Exception):
    status_code = 400
    code = "app_error"

    def __init__(self, message: str, *, details: dict | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.details = details or {}


class ValidationFailed(AppError):
    status_code = 422
    code = "validation_failed"


class InvalidRepositoryUrl(ValidationFailed):
    code = "invalid_repository_url"


class NotFound(AppError):
    status_code = 404
    code = "not_found"


class Conflict(AppError):
    status_code = 409
    code = "conflict"


class AcquisitionError(AppError):
    status_code = 502
    code = "acquisition_failed"


class LimitExceeded(AppError):
    status_code = 413
    code = "limit_exceeded"


class UnsafeContent(AppError):
    status_code = 400
    code = "unsafe_content"


class AgentUnavailable(AppError):
    status_code = 503
    code = "agent_unavailable"


class AgentError(AppError):
    status_code = 502
    code = "agent_error"


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _app_error(_: Request, exc: AppError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": {"code": exc.code, "message": exc.message, "details": exc.details}},
        )

    @app.exception_handler(Exception)
    async def _unhandled(_: Request, exc: Exception) -> JSONResponse:
        log.exception("unhandled error: %s", type(exc).__name__)
        return JSONResponse(
            status_code=500,
            content={"error": {"code": "internal_error", "message": "Internal server error", "details": {}}},
        )
