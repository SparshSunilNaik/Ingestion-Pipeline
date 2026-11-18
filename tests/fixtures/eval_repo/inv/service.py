from inv.storage import Repo


class InventoryService:
    def __init__(self, repo: Repo) -> None:
        self.repo = repo

    def lookup(self, sku: str) -> dict:
        record = self.repo.fetch(sku)
        return self._present(record)

    def register(self, sku: str, qty: int) -> dict:
        self.repo.save(sku, qty)
        return self.lookup(sku)

    def _present(self, record):
        return {"sku": record[0], "qty": record[1]}


def make_service(repo: Repo) -> InventoryService:
    return InventoryService(repo)
