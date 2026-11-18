import pytest

from app.ingestion.classify import classify, looks_binary, unsafe_path_reason


@pytest.mark.parametrize(
    ("path", "category", "language", "excluded"),
    [
        ("app/main.py", "source", "python", None),
        ("src/index.tsx", "source", "typescript", None),
        ("lib/a.mjs", "source", "javascript", None),
        ("tests/test_x.py", "test", "python", None),
        ("src/x.test.ts", "test", "typescript", None),
        ("pkg/foo_test.go", "test", "go", None),
        ("README.md", "documentation", "markdown", None),
        ("docs/guide.rst", "documentation", "restructuredtext", None),
        ("package.json", "dependency_manifest", "json", None),
        ("requirements-dev.txt", "dependency_manifest", None, None),
        ("pyproject.toml", "dependency_manifest", "toml", None),
        ("package-lock.json", "dependency_manifest", "json", "lockfile"),
        (".github/workflows/ci.yml", "ci", "yaml", None),
        ("Dockerfile", "container", "dockerfile", None),
        ("docker-compose.yml", "container", "yaml", None),
        ("tsconfig.json", "configuration", "json", None),
        ("node_modules/react/index.js", "dependency_vendor", "javascript", "dependency_directory"),
        ("web/.next/server.js", "dependency_vendor", "javascript", "dependency_directory"),
        ("dist/bundle.js", "generated", "javascript", "generated_artifact"),
        ("static/app.min.js", "generated", "javascript", "generated_artifact"),
        ("proto/x_pb2.py", "generated", "python", "generated_artifact"),
        ("img/logo.png", "binary", None, "binary"),
        ("tools/x.exe", "binary", None, "binary"),
        ("LICENSE", "other", None, None),
    ],
)
def test_classify(path: str, category: str, language: str | None, excluded: str | None) -> None:
    c = classify(path)
    assert c.category == category
    assert c.language == language
    assert c.exclusion_reason == excluded


@pytest.mark.parametrize(
    ("path", "reason"),
    [
        ("../etc/passwd", "path_traversal"),
        ("a/../../b", "path_traversal"),
        ("a//b", "path_traversal"),
        ("/etc/passwd", "absolute_path"),
        ("C:/Windows/win.ini", "absolute_path"),
        ("a\\b", "invalid_path_characters"),
        ("file.txt:stream", "alternate_data_stream_or_drive"),
        ("dir/CON", "windows_reserved_name"),
        ("nul.txt", "windows_reserved_name"),
        ("trailing. ", "trailing_dot_or_space"),
        ("bad\x01name", "control_characters"),
        ("./a", "path_traversal"),
    ],
)
def test_unsafe_paths(path: str, reason: str) -> None:
    assert unsafe_path_reason(path) == reason


def test_safe_paths() -> None:
    for p in ("a/b.py", ".github/workflows/ci.yml", "src/con_utils.py", "x/.env.example"):
        assert unsafe_path_reason(p) is None


def test_binary_detection() -> None:
    assert looks_binary(b"\x00\x01abc")
    assert not looks_binary("héllo wörld".encode())
    assert not looks_binary(b"")
    assert looks_binary(b"\xff\xfe\xfa" * 100)
