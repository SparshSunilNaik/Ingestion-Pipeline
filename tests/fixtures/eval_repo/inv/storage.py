from abc import ABC, abstractmethod


class Repo(ABC):
    @abstractmethod
    def fetch(self, sku: str) -> tuple: ...

    @abstractmethod
    def save(self, sku: str, qty: int) -> None: ...


class MemoryRepo(Repo):
    def __init__(self) -> None:
        self.rows: dict = {}

    def fetch(self, sku: str) -> tuple:
        return (sku, self.rows.get(sku, 0))

    def save(self, sku: str, qty: int) -> None:
        self.rows[sku] = qty
