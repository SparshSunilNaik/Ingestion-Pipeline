from svc.core.auth import login


def test_login():
    assert login("Bob", "pass1")
