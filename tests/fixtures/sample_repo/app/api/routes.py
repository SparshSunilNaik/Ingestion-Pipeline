from fastapi import APIRouter

from ..services.inventory import InventoryService, make_item

router = APIRouter()
service = InventoryService()


@router.get("/items")
def list_items() -> list:
    return service.list_items()


@router.post("/items")
def create_item(name: str) -> dict:
    item = make_item(name)
    service.add(item)
    return item
