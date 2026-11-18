from .models import Account
from .tokens import issue_token


def check_password(account: Account, password: str) -> bool:
    return account.validate() and len(password) > 3


def login(name: str, password: str) -> str:
    account = Account.create(name)
    if not check_password(account, password):
        raise ValueError("denied")
    return issue_token(account)
