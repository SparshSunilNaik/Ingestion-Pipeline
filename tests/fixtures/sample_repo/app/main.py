"""Application entry point."""

import yaml
from fastapi import FastAPI

from app.api.routes import router
from app.services.inventory import InventoryService

app = FastAPI(title="Sample Inventory")
app.include_router(router)


@app.get("/health")
def health() -> dict:
    return {"ok": True}


def run() -> None:
    service = InventoryService()
    service.load(yaml.safe_load("[]"))


if __name__ == "__main__":
    run()
