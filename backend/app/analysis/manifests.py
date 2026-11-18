"""Dependency manifest parsers (declarative files only; nothing is executed).

``setup.py`` is intentionally not evaluated: it is executable code.
"""

from __future__ import annotations

import json
import posixpath
import re
import tomllib
from dataclasses import dataclass, field
from typing import Any

_REQ_NAME = re.compile(r"^\s*([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*(.*)$")


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


@dataclass
class DeclaredDependency:
    ecosystem: str  # python|npm
    name: str
    specifier: str | None
    scope: str  # runtime|dev|optional|peer
    manifest_path: str
    line: int


@dataclass
class ManifestInfo:
    path: str
    kind: str
    dependencies: list[DeclaredDependency] = field(default_factory=list)
    scripts: dict[str, tuple[str, int]] = field(default_factory=dict)  # name -> (command, line)
    entry_points: list[tuple[str, str, int]] = field(default_factory=list)  # (kind, value, line)
    metadata: dict[str, str] = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)


def normalize_python_name(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def _find_line(lines: list[str], needle: str, default: int = 1) -> int:
    for i, line in enumerate(lines, 1):
        if needle in line:
            return i
    return default


def parse_manifest(path: str, text: str) -> ManifestInfo | None:
    name = posixpath.basename(path).lower()
    if name == "package.json":
        return _package_json(path, text)
    if name == "pyproject.toml":
        return _pyproject(path, text)
    if name.startswith("requirements") and name.endswith(".txt"):
        return _requirements(path, text, scope="dev" if "dev" in name or "test" in name else "runtime")
    if name == "go.mod":
        return _go_mod(path, text)
    if name == "pom.xml":
        return _pom(path, text)
    if name in ("build.gradle", "build.gradle.kts"):
        return _gradle(path, text)
    return None


def _go_mod(path: str, text: str) -> ManifestInfo:
    info = ManifestInfo(path=path, kind="go.mod")
    in_block = False
    for i, raw in enumerate(text.splitlines(), 1):
        line = raw.split("//")[0].strip()
        indirect = "// indirect" in raw
        if line.startswith("module "):
            info.metadata["module"] = line.split()[1]
        elif line.startswith("go ") and len(line.split()) == 2:
            info.metadata["go"] = line.split()[1]
        elif line.startswith("require ("):
            in_block = True
        elif in_block and line == ")":
            in_block = False
        elif in_block or line.startswith("require "):
            parts = line.removeprefix("require ").split()
            if len(parts) >= 2:
                info.dependencies.append(DeclaredDependency("go", parts[0], parts[1], "indirect" if indirect else "runtime", path, i))
    return info


_POM_DEP = re.compile(r"<dependency>(.*?)</dependency>", re.S)
_POM_FIELDS = re.compile(r"<(groupId|artifactId|version|scope)>\s*([^<]+?)\s*</(?:groupId|artifactId|version|scope)>")


def _pom(path: str, text: str) -> ManifestInfo:
    """Extract <dependency> blocks with a non-validating regex scan (no XML entity expansion)."""
    info = ManifestInfo(path=path, kind="pom.xml")
    for m in _POM_DEP.finditer(text):
        tags = dict(_POM_FIELDS.findall(m.group(1)))
        if "groupId" in tags and "artifactId" in tags:
            line = text.count("\n", 0, m.start()) + 1
            scope = "dev" if tags.get("scope") == "test" else "runtime"
            info.dependencies.append(DeclaredDependency("maven", f"{tags['groupId']}:{tags['artifactId']}", tags.get("version"), scope, path, line))
    return info


_GRADLE_DEP = re.compile(
    r"""^\s*(implementation|api|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly)\s*\(?\s*["']([^:"']+):([^:"']+)(?::([^"']+))?["']"""
)


def _gradle(path: str, text: str) -> ManifestInfo:
    """Pattern extraction of string-notation dependencies. The build script is never executed."""
    info = ManifestInfo(path=path, kind="gradle")
    for i, raw in enumerate(text.splitlines(), 1):
        m = _GRADLE_DEP.match(raw)
        if m:
            scope = "dev" if m.group(1).startswith("test") else "runtime"
            info.dependencies.append(DeclaredDependency("maven", f"{m.group(2)}:{m.group(3)}", m.group(4), scope, path, i))
    return info


def _package_json(path: str, text: str) -> ManifestInfo:
    info = ManifestInfo(path=path, kind="package.json")
    lines = text.splitlines()
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        info.errors.append(f"invalid_json: {exc.msg}")
        return info
    if not isinstance(data, dict):
        info.errors.append("not_an_object")
        return info
    for key in ("name", "description", "version"):
        if isinstance(data.get(key), str):
            info.metadata[key] = data[key][:300]
    scopes = {"dependencies": "runtime", "devDependencies": "dev", "peerDependencies": "peer", "optionalDependencies": "optional"}
    for key, scope in scopes.items():
        deps = data.get(key)
        if isinstance(deps, dict):
            section_line = _find_line(lines, f'"{key}"')
            for dep, spec in deps.items():
                line = section_line
                for i in range(section_line - 1, len(lines)):
                    if f'"{dep}"' in lines[i]:
                        line = i + 1
                        break
                info.dependencies.append(DeclaredDependency("npm", str(dep), str(spec)[:200], scope, path, line))
    scripts = data.get("scripts")
    if isinstance(scripts, dict):
        for sname, cmd in scripts.items():
            if isinstance(cmd, str):
                info.scripts[str(sname)] = (cmd[:500], _find_line(lines, f'"{sname}"'))
    for key in ("main", "module"):
        if isinstance(data.get(key), str):
            info.entry_points.append((f"package_{key}", data[key], _find_line(lines, f'"{key}"')))
    bin_field = data.get("bin")
    if isinstance(bin_field, str):
        info.entry_points.append(("package_bin", bin_field, _find_line(lines, '"bin"')))
    elif isinstance(bin_field, dict):
        for bname, target in bin_field.items():
            info.entry_points.append(("package_bin", f"{bname} -> {target}", _find_line(lines, f'"{bname}"')))
    return info


def _pep508_name(req: str) -> tuple[str, str | None] | None:
    req = req.split(";")[0].strip()
    m = _REQ_NAME.match(req)
    if not m:
        return None
    spec = (m.group(3) or "").strip() or None
    return m.group(1), spec


def _requirements(path: str, text: str, scope: str) -> ManifestInfo:
    info = ManifestInfo(path=path, kind="requirements")
    for i, raw in enumerate(text.splitlines(), 1):
        line = raw.split(" #")[0].strip()
        if not line or line.startswith(("#", "-", "git+", "http:", "https:", "file:")):
            continue
        parsed = _pep508_name(line)
        if parsed:
            info.dependencies.append(DeclaredDependency("python", parsed[0], parsed[1], scope, path, i))
    return info


def _pyproject(path: str, text: str) -> ManifestInfo:
    info = ManifestInfo(path=path, kind="pyproject.toml")
    lines = text.splitlines()
    try:
        data = tomllib.loads(text)
    except tomllib.TOMLDecodeError as exc:
        info.errors.append(f"invalid_toml: {exc}")
        return info
    project = _as_dict(data.get("project"))
    for key in ("name", "description", "version", "requires-python"):
        if isinstance(project.get(key), str):
            info.metadata[key] = project[key][:300]

    def add(reqs: object, scope: str) -> None:
        if not isinstance(reqs, list):
            return
        for req in reqs:
            if not isinstance(req, str):
                continue
            parsed = _pep508_name(req)
            if parsed:
                line = _find_line(lines, req) if req in text else _find_line(lines, parsed[0])
                info.dependencies.append(DeclaredDependency("python", parsed[0], parsed[1], scope, path, line))

    add(project.get("dependencies"), "runtime")
    opt = project.get("optional-dependencies")
    if isinstance(opt, dict):
        for group in opt.values():
            add(group, "optional")
    groups = data.get("dependency-groups")
    if isinstance(groups, dict):
        for group in groups.values():
            add(group, "dev")
    tool = _as_dict(data.get("tool"))
    uv = _as_dict(tool.get("uv"))
    add(uv.get("dev-dependencies"), "dev")
    poetry = _as_dict(tool.get("poetry"))
    for key, scope in (("dependencies", "runtime"), ("dev-dependencies", "dev")):
        deps = poetry.get(key)
        if isinstance(deps, dict):
            for dep, spec in deps.items():
                if dep.lower() == "python":
                    continue
                info.dependencies.append(DeclaredDependency("python", dep, str(spec)[:200], scope, path, _find_line(lines, dep)))
    pgroups = poetry.get("group")
    if isinstance(pgroups, dict):
        for g in pgroups.values():
            deps = g.get("dependencies") if isinstance(g, dict) else None
            if isinstance(deps, dict):
                for dep, spec in deps.items():
                    info.dependencies.append(DeclaredDependency("python", dep, str(spec)[:200], "dev", path, _find_line(lines, dep)))
    scripts = project.get("scripts")
    if isinstance(scripts, dict):
        for sname, target in scripts.items():
            info.entry_points.append(("console_script", f"{sname} = {target}", _find_line(lines, str(sname))))
    return info


# Import name -> distribution name for common mismatches. Used only to *match*;
# a missing entry never makes a dependency "unused".
PYTHON_IMPORT_TO_DIST = {
    "yaml": "pyyaml",
    "PIL": "pillow",
    "sklearn": "scikit-learn",
    "cv2": "opencv-python",
    "bs4": "beautifulsoup4",
    "dateutil": "python-dateutil",
    "dotenv": "python-dotenv",
    "jwt": "pyjwt",
    "google": "protobuf",
    "attr": "attrs",
    "magic": "python-magic",
    "multipart": "python-multipart",
    "jose": "python-jose",
    "Crypto": "pycryptodome",
    "OpenSSL": "pyopenssl",
    "pkg_resources": "setuptools",
    "serial": "pyserial",
    "telegram": "python-telegram-bot",
    "docx": "python-docx",
    "pptx": "python-pptx",
    "MySQLdb": "mysqlclient",
    "psycopg2": "psycopg2-binary",
    "fitz": "pymupdf",
    "zmq": "pyzmq",
    "usb": "pyusb",
    "skimage": "scikit-image",
    "tree_sitter": "tree-sitter",
    "pydantic_settings": "pydantic-settings",
    "typing_extensions": "typing-extensions",
}
