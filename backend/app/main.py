"""FastAPI application factory."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.agents.runtime import OpenCodeRuntime
from app.api.routes import VERSION, router
from app.core.config import Settings, get_settings
from app.core.errors import install_error_handlers
from app.core.logging import configure_logging, get_logger
from app.database.engine import init_engine
from app.database.migrate import upgrade_database
from app.ingestion.pipeline import IngestionPipeline
from app.ingestion.worker import Worker

log = get_logger(__name__)


def create_app(settings: Settings | None = None, pipeline: IngestionPipeline | None = None, runtime: OpenCodeRuntime | None = None) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.log_level, settings.log_json)
    settings.ensure_dirs()
    url = settings.resolved_database_url
    upgrade_database(url)
    init_engine(url)
    runtime = runtime or OpenCodeRuntime(settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        worker = None
        if settings.start_worker:
            worker = Worker(settings, runtime, pipeline)
            worker.start()
        app.state.worker = worker
        yield
        if worker:
            worker.stop()
        runtime.stop()

    app = FastAPI(
        title="Ingestion-Pipeline API",
        version=VERSION,
        lifespan=lifespan,
        description="Evidence-grounded repository intelligence. All analysis is static; repository code is never executed.",
    )
    app.state.settings = settings
    app.state.runtime = runtime
    app.state.worker = None
    app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_methods=["GET", "POST", "PUT"], allow_headers=["content-type"])
    install_error_handlers(app)
    app.include_router(router)
    return app


def app_factory() -> FastAPI:
    return create_app()
