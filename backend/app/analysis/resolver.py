"""Import resolution for Python and TypeScript/JavaScript.

Resolution statuses:
  resolved   - specifier maps to exactly one analysed file in the snapshot
  ambiguous  - specifier maps to more than one candidate file
  external   - third-party package (or standard library, flagged separately)
  unresolved - looks internal (relative/alias) but no analysed file matches
"""

from __future__ import annotations

import json
import posixpath
import re
import sys
from dataclasses import dataclass

_NODE_BUILTINS = {
    "assert",
    "async_hooks",
    "buffer",
    "child_process",
    "cluster",
    "console",
    "crypto",
    "dgram",
    "dns",
    "events",
    "fs",
    "http",
    "http2",
    "https",
    "module",
    "net",
    "os",
    "path",
    "perf_hooks",
    "process",
    "querystring",
    "readline",
    "stream",
    "string_decoder",
    "timers",
    "tls",
    "tty",
    "url",
    "util",
    "v8",
    "vm",
    "worker_threads",
    "zlib",
}
_JS_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".d.ts"]
PY_STDLIB = set(sys.stdlib_module_names) | {"__future__"}


@dataclass
class Resolution:
    status: str  # resolved|ambiguous|external|unresolved|stdlib
    target_path: str | None = None
    candidates: list[str] | None = None
    package: str | None = None  # external package name


def _strip_jsonc(text: str) -> str:
    out = []
    i = 0
    in_str = False
    while i < len(text):
        c = text[i]
        if in_str:
            out.append(c)
            if c == "\\" and i + 1 < len(text):
                out.append(text[i + 1])
                i += 2
                continue
            if c == '"':
                in_str = False
        elif c == '"':
            in_str = True
            out.append(c)
        elif text.startswith("//", i):
            j = text.find("\n", i)
            i = len(text) if j == -1 else j
            continue
        elif text.startswith("/*", i):
            j = text.find("*/", i + 2)
            i = len(text) if j == -1 else j + 2
            continue
        else:
            out.append(c)
        i += 1
    return re.sub(r",(\s*[}\]])", r"\1", "".join(out))


class ModuleIndex:
    def __init__(self, analyzed_paths: set[str], all_paths: set[str]) -> None:
        self.paths = analyzed_paths
        self.all_paths = all_paths
        self.py_index: dict[str, set[str]] = {}
        self.package_dirs = {posixpath.dirname(p) for p in all_paths if posixpath.basename(p) == "__init__.py"}
        for p in analyzed_paths:
            if p.endswith((".py", ".pyi")):
                for name in self._python_names(p):
                    self.py_index.setdefault(name, set()).add(p)
        self.ts_aliases: list[tuple[str, str, list[str]]] = []  # (config_dir, prefix, [target_prefixes])

    # -- python --------------------------------------------------------------
    def _python_names(self, path: str) -> list[str]:
        no_ext = path.rsplit(".", 1)[0]
        parts = no_ext.split("/")
        if parts[-1] == "__init__":
            parts = parts[:-1]
        if not parts:
            return []
        # every suffix is a candidate import name (handles src/ layouts, backend/app, etc.)
        return [".".join(parts[i:]) for i in range(len(parts))]

    def python_module_name(self, path: str) -> str:
        """Best-effort dotted name: walk up while parent dirs are packages."""
        no_ext = path.rsplit(".", 1)[0]
        parts = no_ext.split("/")
        if parts[-1] == "__init__":
            parts = parts[:-1]
        start = len(parts) - 1
        while start > 0 and "/".join(parts[:start]) in self.package_dirs:
            start -= 1
        if start < len(parts) - 1 and "/".join(parts[: start + 1]) not in self.package_dirs:
            start += 1
        return ".".join(parts[start:]) or no_ext.replace("/", ".")

    def resolve_python(self, importer: str, spec: str, level: int, imported_name: str | None = None) -> Resolution:
        if level > 0:
            base_parts = posixpath.dirname(importer).split("/") if posixpath.dirname(importer) else []
            if level - 1 > len(base_parts):
                return Resolution("unresolved")
            base_parts = base_parts[: len(base_parts) - (level - 1)] if level > 1 else base_parts
            base = "/".join(base_parts)
            rel = spec.replace(".", "/") if spec else ""
            stem = posixpath.join(base, rel) if rel else base
            options = []
            if imported_name and imported_name != "*":
                options += [f"{stem}/{imported_name}.py", f"{stem}/{imported_name}/__init__.py"]
            options += [f"{stem}.py", f"{stem}/__init__.py", f"{stem}.pyi"]
            for opt in options:
                opt = opt.lstrip("/")
                if opt in self.paths:
                    return Resolution("resolved", target_path=opt)
            return Resolution("unresolved")
        top = spec.split(".")[0]
        names = []
        if imported_name and imported_name != "*":
            names.append(f"{spec}.{imported_name}")
        names.append(spec)
        for name in names:
            cands = self.py_index.get(name)
            if cands:
                if len(cands) == 1:
                    return Resolution("resolved", target_path=next(iter(cands)))
                best = self._closest(importer, cands)
                if best:
                    return Resolution("resolved", target_path=best, candidates=sorted(cands))
                return Resolution("ambiguous", candidates=sorted(cands))
        if top in PY_STDLIB:
            return Resolution("stdlib", package=top)
        return Resolution("external", package=top)

    @staticmethod
    def _closest(importer: str, cands: set[str]) -> str | None:
        def shared(p: str) -> int:
            a, b = importer.split("/"), p.split("/")
            n = 0
            for x, y in zip(a, b, strict=False):
                if x != y:
                    break
                n += 1
            return n

        ranked = sorted(cands, key=lambda p: (-shared(p), p.count("/")))
        if len(ranked) > 1 and shared(ranked[0]) == shared(ranked[1]) and ranked[0].count("/") == ranked[1].count("/"):
            return None
        return ranked[0]

    # -- typescript / javascript --------------------------------------------
    def load_ts_aliases(self, configs: dict[str, str]) -> None:
        for path, text in configs.items():
            try:
                data = json.loads(_strip_jsonc(text))
            except (json.JSONDecodeError, ValueError):
                continue
            opts = data.get("compilerOptions") if isinstance(data, dict) else None
            if not isinstance(opts, dict):
                continue
            cfg_dir = posixpath.dirname(path)
            base_url = opts.get("baseUrl", ".") if isinstance(opts.get("baseUrl"), str) else "."
            base = posixpath.normpath(posixpath.join(cfg_dir, base_url)) if cfg_dir or base_url != "." else ""
            base = "" if base == "." else base
            paths = opts.get("paths")
            if isinstance(paths, dict):
                for alias, targets in paths.items():
                    if not isinstance(targets, list) or not alias.endswith("*"):
                        continue
                    tprefixes = [posixpath.normpath(posixpath.join(base, t.rstrip("*"))) + "/" for t in targets if isinstance(t, str) and t.endswith("*")]
                    tprefixes = [t.removeprefix("./") for t in tprefixes]
                    self.ts_aliases.append((cfg_dir, alias[:-1], [("" if t == "./" else t) for t in tprefixes]))

    def _try_js_file(self, stem: str) -> str | None:
        stem = posixpath.normpath(stem)
        if stem.startswith("../") or stem == "..":
            return None
        stem = "" if stem == "." else stem
        if stem in self.paths:
            return stem
        # TS ESM style: import "./x.js" that refers to x.ts
        root, ext = posixpath.splitext(stem)
        if ext in (".js", ".jsx", ".mjs", ".cjs"):
            for e in (".ts", ".tsx", ".mts", ".cts"):
                if root + e in self.paths:
                    return root + e
        for e in _JS_EXTS:
            if stem + e in self.paths:
                return stem + e
        for e in _JS_EXTS:
            cand = posixpath.join(stem, "index" + e) if stem else "index" + e
            if cand in self.paths:
                return cand
        return None

    def resolve_js(self, importer: str, spec: str) -> Resolution:
        if spec.startswith("node:"):
            return Resolution("stdlib", package=spec[5:].split("/")[0])
        if spec.startswith((".", "/")):
            base = posixpath.dirname(importer)
            target = self._try_js_file(posixpath.join(base, spec) if not spec.startswith("/") else spec.lstrip("/"))
            return Resolution("resolved", target_path=target) if target else Resolution("unresolved")
        # tsconfig path aliases: prefer the config closest to the importer
        for cfg_dir, prefix, targets in sorted(self.ts_aliases, key=lambda a: -len(a[0])):
            if cfg_dir and not importer.startswith(cfg_dir + "/"):
                continue
            if spec.startswith(prefix) and prefix:
                rest = spec[len(prefix) :]
                for t in targets:
                    target = self._try_js_file(t + rest)
                    if target:
                        return Resolution("resolved", target_path=target)
                return Resolution("unresolved")
        pkg = "/".join(spec.split("/")[:2]) if spec.startswith("@") else spec.split("/")[0]
        if pkg in _NODE_BUILTINS:
            return Resolution("stdlib", package=pkg)
        return Resolution("external", package=pkg)
