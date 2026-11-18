import pytest

from app.core.errors import InvalidRepositoryUrl
from app.ingestion.url import parse_github_url


@pytest.mark.parametrize(
    ("raw", "owner", "name"),
    [
        ("https://github.com/psf/requests", "psf", "requests"),
        ("https://github.com/psf/requests/", "psf", "requests"),
        ("https://github.com/psf/requests.git", "psf", "requests"),
        ("  https://github.com/a-b/c.d_e  ", "a-b", "c.d_e"),
        ("https://www.github.com/Owner/Repo", "Owner", "Repo"),
        ("HTTPS://GitHub.com/o/r", "o", "r"),
    ],
)
def test_valid_urls(raw: str, owner: str, name: str) -> None:
    ref = parse_github_url(raw)
    assert (ref.owner, ref.name) == (owner, name)
    assert ref.canonical_url == f"https://github.com/{owner}/{name}"


@pytest.mark.parametrize(
    "raw",
    [
        "",
        "http://github.com/a/b",
        "git@github.com:a/b.git",
        "ssh://git@github.com/a/b",
        "file:///etc/passwd",
        "https://gitlab.com/a/b",
        "https://github.com.evil.com/a/b",
        "https://evil.com/github.com/a/b",
        "https://user:pass@github.com/a/b",
        "https://token@github.com/a/b",
        "https://github.com:443/a/b",
        "https://github.com:8080/a/b",
        "https://github.com/a",
        "https://github.com/a/b/tree/main",
        "https://github.com/a/b/blob/main/README.md",
        "https://github.com/a/b?tab=readme",
        "https://github.com/a/b#readme",
        "https://github.com/../b",
        "https://github.com/a/..",
        "https://github.com/a/.",
        "https://github.com/a/b%2F..",
        "https://github.com/-a/b",
        "https://github.com/a--/b",
        "https://github.com/a/b c",
        "https://github.com/a/b\nx",
        "https://github.com\\a\\b",
        "https://github.com/a/b;rm -rf",
        "https://github.com/a/ü",
        "https://github.com//a/b",
        "https://github.com/a/" + "x" * 101,
        "javascript:alert(1)",
    ],
)
def test_invalid_urls(raw: str) -> None:
    with pytest.raises(InvalidRepositoryUrl):
        parse_github_url(raw)
