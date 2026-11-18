class Account:
    def __init__(self, name: str) -> None:
        self.name = name

    def validate(self) -> bool:
        return bool(self.name)

    def describe(self) -> str:
        return self.label()

    def label(self) -> str:
        return f"account:{self.name}"

    @staticmethod
    def normalize(name: str) -> str:
        return name.strip().lower()

    @classmethod
    def create(cls, name: str) -> "Account":
        return cls(cls.normalize(name))


class Admin(Account):
    def label(self) -> str:
        return f"admin:{self.name}"

    def promote(self) -> str:
        self.validate()
        return super().describe()
