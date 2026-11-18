"""Inventory domain logic."""


def make_item(name: str) -> dict:
    return {"name": name.strip()}


class BaseService:
    def describe(self) -> str:
        return type(self).__name__


class InventoryService(BaseService):
    """Keeps items in memory."""

    def __init__(self) -> None:
        self.items: list[dict] = []

    def add(self, item: dict) -> None:
        self.validate(item)
        self.items.append(item)

    def validate(self, item: dict) -> None:
        if not item.get("name"):
            raise ValueError("name required")

    def list_items(self) -> list[dict]:
        return list(self.items)

    def load(self, rows: list) -> None:
        for row in rows:
            self.add(make_item(row))
