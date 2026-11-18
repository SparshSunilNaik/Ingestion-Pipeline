def issue_token(account) -> str:
    return sign(account.name)


def sign(value: str) -> str:
    return value[::-1]
