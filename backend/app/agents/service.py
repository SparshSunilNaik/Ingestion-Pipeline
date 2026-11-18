"""Agent report jobs and model selection."""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.agents.runtime import OpenCodeRuntime
from app.agents.workflow import InvestigationWorkflow
from app.core.config import Settings
from app.core.errors import AgentError, AgentUnavailable, AppError
from app.core.logging import get_logger
from app.database.models import AppSetting, Job, Snapshot
from app.ingestion import jobs as jobstore
from app.reports.builder import build_report_model, save_report

log = get_logger(__name__)
MODEL_KEY = "opencode_model"


def selected_model(session: Session, settings: Settings) -> str:
    row = session.get(AppSetting, MODEL_KEY)
    return row.value if row else settings.opencode.default_model


def set_selected_model(session: Session, model: str) -> None:
    row = session.get(AppSetting, MODEL_KEY)
    if row is None:
        session.add(AppSetting(key=MODEL_KEY, value=model))
    else:
        row.value = model
    session.commit()


def run_agent_job(session: Session, runtime: OpenCodeRuntime, job_id: int) -> None:
    job = session.get(Job, job_id)
    assert job is not None
    try:
        if not runtime.enabled:
            raise AgentUnavailable("Agent runtime is disabled by configuration")
        snapshot = session.get(Snapshot, job.snapshot_id)
        if snapshot is None or snapshot.status != "ready":
            raise AgentError("Snapshot is not ready for agent analysis")
        model = str((job.params or {}).get("model") or "")
        if not model:
            raise AgentError("Agent job has no model configured")
        jobstore.update_progress(session, job_id, "connecting", 5, "Connecting to OpenCode")
        adapter = runtime.adapter()
        try:
            adapter.resolve_model(model)  # fails loudly; never substitutes a different model
            jobstore.update_progress(session, job_id, "investigating", 20, f"Investigating with {model}")

            def generate(prompt: str) -> tuple[str, dict]:
                res = adapter.generate(prompt, model)
                return res.text, {"latency_ms": res.latency_ms, "prompt_chars": res.prompt_chars, "response_chars": res.response_chars}

            result = InvestigationWorkflow(session, snapshot, generate).run(lambda: jobstore.cancel_requested(session, job_id))
        finally:
            adapter.close()
        jobstore.update_progress(session, job_id, "validating", 90, "Validating cited evidence")
        report = build_report_model(session, snapshot, agent_sections=result.sections, model=model)
        save_report(session, snapshot, report, kind="agent", usage={**result.usage, "validation": result.validation})
        jobstore.finish_job(session, job_id, "succeeded")
    except AppError as exc:
        session.rollback()
        kind = exc.details.get("kind") if isinstance(exc.details, dict) else None
        status = "cancelled" if kind == "cancelled" else "failed"
        log.warning("agent job %s %s: %s", job_id, status, exc.message)
        jobstore.finish_job(session, job_id, status, error_code=exc.code if status == "failed" else "cancelled", error_message=exc.message)
    except Exception as exc:
        session.rollback()
        log.exception("agent job %s crashed", job_id)
        jobstore.finish_job(session, job_id, "failed", error_code="internal_error", error_message=type(exc).__name__)
