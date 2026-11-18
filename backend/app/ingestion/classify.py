"""Deterministic file classification: language, category and exclusion rules."""

from __future__ import annotations

import posixpath
import re
from dataclasses import dataclass

LANGUAGE_BY_EXT: dict[str, str] = {
    ".py": "python",
    ".pyi": "python",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".mts": "typescript",
    ".cts": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".kt": "kotlin",
    ".rb": "ruby",
    ".php": "php",
    ".cs": "csharp",
    ".c": "c",
    ".h": "c",
    ".cpp": "cpp",
    ".cc": "cpp",
    ".hpp": "cpp",
    ".swift": "swift",
    ".scala": "scala",
    ".sh": "shell",
    ".ps1": "powershell",
    ".sql": "sql",
    ".html": "html",
    ".css": "css",
    ".scss": "scss",
    ".vue": "vue",
    ".svelte": "svelte",
    ".md": "markdown",
    ".rst": "restructuredtext",
    ".json": "json",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".toml": "toml",
    ".ini": "ini",
    ".cfg": "ini",
    ".xml": "xml",
}

PARSED_LANGUAGES = {"python", "typescript", "javascript"}
PROGRAMMING_LANGUAGES = {
    "python",
    "typescript",
    "javascript",
    "go",
    "rust",
    "java",
    "kotlin",
    "ruby",
    "php",
    "csharp",
    "c",
    "cpp",
    "swift",
    "scala",
    "shell",
    "powershell",
    "sql",
    "vue",
    "svelte",
}

DEPENDENCY_MANIFESTS = {
    "package.json",
    "requirements.txt",
    "pyproject.toml",
    "setup.py",
    "setup.cfg",
    "pipfile",
    "poetry.lock",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "uv.lock",
    "go.mod",
    "cargo.toml",
    "gemfile",
    "composer.json",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
}
LOCKFILES = {"poetry.lock", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "uv.lock", "cargo.lock", "gemfile.lock"}
DOC_NAMES = {"readme", "contributing", "changelog", "license", "code_of_conduct", "security", "authors", "history"}
CONFIG_NAMES = {
    ".gitignore",
    ".editorconfig",
    "tsconfig.json",
    ".eslintrc",
    ".eslintrc.json",
    ".eslintrc.js",
    "eslint.config.js",
    "eslint.config.mjs",
    ".prettierrc",
    "next.config.js",
    "next.config.mjs",
    "next.config.ts",
    "vite.config.ts",
    "vite.config.js",
    "webpack.config.js",
    "babel.config.js",
    "jest.config.js",
    "tox.ini",
    "pytest.ini",
    "mypy.ini",
    ".flake8",
    "ruff.toml",
    "makefile",
    "alembic.ini",
    ".env.example",
    "tailwind.config.js",
    "tailwind.config.ts",
    "postcss.config.js",
    "postcss.config.mjs",
}
CONTAINER_NAMES = {"dockerfile", "docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml", ".dockerignore"}
EXCLUDED_DIRS = {
    "node_modules",
    "vendor",
    ".venv",
    "venv",
    "env",
    "site-packages",
    "__pycache__",
    ".git",
    "bower_components",
    ".tox",
    ".mypy_cache",
    ".pytest_cache",
    ".next",
    ".nuxt",
    ".turbo",
    ".cache",
}
GENERATED_DIRS = {"dist", "build", "out", "coverage", "target", ".output", "htmlcov"}
BINARY_EXTS = {
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".bmp",
    ".ico",
    ".webp",
    ".pdf",
    ".zip",
    ".gz",
    ".tar",
    ".tgz",
    ".7z",
    ".rar",
    ".exe",
    ".dll",
    ".so",
    ".dylib",
    ".bin",
    ".class",
    ".jar",
    ".pyc",
    ".pyo",
    ".woff",
    ".woff2",
    ".ttf",
    ".otf",
    ".eot",
    ".mp3",
    ".mp4",
    ".mov",
    ".avi",
    ".wav",
    ".ogg",
    ".webm",
    ".psd",
    ".sqlite",
    ".db",
    ".wasm",
    ".npy",
    ".pkl",
    ".h5",
    ".onnx",
    ".pt",
}
_GENERATED_FILE_RE = re.compile(r"(\.min\.(js|css)|\.bundle\.js|\.map|_pb2\.py|\.pb\.go|\.generated\.\w+)$", re.I)
_TEST_RE = re.compile(r"(^|/)(tests?|__tests__|spec|specs)/|(^|/)test_[^/]+\.py$|_test\.(py|go)$|\.(test|spec)\.[jt]sx?$", re.I)
_WINDOWS_RESERVED = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))}


@dataclass(frozen=True)
class Classification:
    category: str
    language: str | None
    exclusion_reason: str | None


def unsafe_path_reason(path: str) -> str | None:
    """Return a reason if a repository-relative path is unsafe to touch, else None."""
    if not path or len(path) > 1000:
        return "invalid_path_length"
    if "\\" in path or "\0" in path:
        return "invalid_path_characters"
    if any(ord(c) < 32 for c in path):
        return "control_characters"
    if path.startswith("/") or re.match(r"^[A-Za-z]:", path):
        return "absolute_path"
    if ":" in path:
        return "alternate_data_stream_or_drive"
    parts = path.split("/")
    for part in parts:
        if part in ("", ".", ".."):
            return "path_traversal"
        stem = part.split(".")[0].lower()
        if stem in _WINDOWS_RESERVED:
            return "windows_reserved_name"
        if part.endswith((" ", ".")):
            return "trailing_dot_or_space"
    if posixpath.normpath(path) != path:
        return "non_normalised_path"
    return None


def classify(path: str) -> Classification:
    lower = path.lower()
    parts = lower.split("/")
    name = parts[-1]
    ext = posixpath.splitext(name)[1]
    language = LANGUAGE_BY_EXT.get(ext)
    if name == "dockerfile" or name.startswith("dockerfile."):
        language = "dockerfile"

    dirs = parts[:-1]
    if any(d in EXCLUDED_DIRS for d in dirs):
        return Classification("dependency_vendor", language, "dependency_directory")
    if any(d in GENERATED_DIRS for d in dirs) or _GENERATED_FILE_RE.search(name):
        return Classification("generated", language, "generated_artifact")
    if name in LOCKFILES:
        return Classification("dependency_manifest", language, "lockfile")
    if ext in BINARY_EXTS:
        return Classification("binary", None, "binary")

    if name in DEPENDENCY_MANIFESTS or (name.startswith("requirements") and ext == ".txt"):
        return Classification("dependency_manifest", language, None)
    if (
        lower.startswith(".github/workflows/")
        or name in {".gitlab-ci.yml", "jenkinsfile", ".travis.yml", "azure-pipelines.yml"}
        or lower.startswith(".circleci/")
    ):
        return Classification("ci", language, None)
    if name in CONTAINER_NAMES or name.startswith("dockerfile"):
        return Classification("container", language, None)
    stem = posixpath.splitext(name)[0]
    if ext in {".md", ".rst", ".txt", ".adoc"} and (stem in DOC_NAMES or (dirs and dirs[0] in {"docs", "doc"}) or ext in {".md", ".rst", ".adoc"}):
        return Classification("documentation", language, None)
    if _TEST_RE.search(lower) and language in PROGRAMMING_LANGUAGES:
        return Classification("test", language, None)
    if name in CONFIG_NAMES or ext in {".toml", ".ini", ".cfg", ".yaml", ".yml", ".json", ".env"} or name.startswith(".env"):
        return Classification("configuration", language, None)
    if language in PROGRAMMING_LANGUAGES:
        return Classification("source", language, None)
    return Classification("other", language, None)


def looks_binary(sample: bytes) -> bool:
    if b"\0" in sample:
        return True
    if not sample:
        return False
    try:
        sample.decode("utf-8")
        return False
    except UnicodeDecodeError as exc:
        # tolerate a truncated multi-byte char at the end of the sample
        return exc.start < len(sample) - 4
