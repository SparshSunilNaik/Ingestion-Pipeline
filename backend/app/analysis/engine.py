"""Deterministic static analysis of one snapshot.

Produces symbols, a repository graph (files, symbols, packages, routes), dependency
status, framework/entry-point findings, documentation sections and evidence records,
then persists everything for the snapshot.
"""

from __future__ import annotations

import posixpath
import re
from collections import Counter, defaultdict
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from sqlalchemy import delete, insert, select
from sqlalchemy.orm import Session

from app.analysis.docs import split_sections
from app.analysis.go_analyzer import GoAnalyzer
from app.analysis.ir import FileAnalysis, LanguageAnalyzer, SymbolInfo, ir_from_dict, ir_to_dict
from app.analysis.java_analyzer import JavaAnalyzer
from app.analysis.manifests import PYTHON_IMPORT_TO_DIST, ManifestInfo, normalize_python_name, parse_manifest
from app.analysis.python_analyzer import PythonAnalyzer
from app.analysis.resolver import ModuleIndex, Resolution
from app.analysis.ts_analyzer import TypeScriptAnalyzer
from app.core.logging import get_logger
from app.database.models import Dependency, Evidence, FileAnalysisCache, FileRecord, Finding, GraphEdge, GraphNode, Repository, Snapshot, Symbol
from app.evidence.collector import EvidenceCollector
from app.evidence.contract import ANALYZER_VERSION, CATEGORY_TO_SOURCE_KIND, EvidenceCategory, ExtractionMethod, SourceKind
from app.graph.builder import GraphBuilder, central_files, file_key, most_referenced, pkg_key, sym_key
from app.ingestion.inventory import resolve_inside
from app.search.fts import index_files

log = get_logger(__name__)

ANALYZERS: list[LanguageAnalyzer] = [PythonAnalyzer(), TypeScriptAnalyzer(), GoAnalyzer(), JavaAnalyzer()]
MAX_UNRESOLVED_CALL_EDGES_PER_FILE = 200

FRAMEWORKS: dict[tuple[str, str], tuple[str, str]] = {
    # (ecosystem, package) -> (framework, role)
    ("python", "fastapi"): ("FastAPI", "web framework"),
    ("python", "flask"): ("Flask", "web framework"),
    ("python", "django"): ("Django", "web framework"),
    ("python", "starlette"): ("Starlette", "web framework"),
    ("python", "sqlalchemy"): ("SQLAlchemy", "ORM / database toolkit"),
    ("python", "alembic"): ("Alembic", "database migrations"),
    ("python", "pydantic"): ("Pydantic", "data validation"),
    ("python", "celery"): ("Celery", "task queue"),
    ("python", "pytest"): ("pytest", "test framework"),
    ("python", "click"): ("Click", "CLI framework"),
    ("python", "typer"): ("Typer", "CLI framework"),
    ("python", "streamlit"): ("Streamlit", "app framework"),
    ("python", "torch"): ("PyTorch", "machine learning"),
    ("python", "tensorflow"): ("TensorFlow", "machine learning"),
    ("python", "numpy"): ("NumPy", "numerical computing"),
    ("python", "pandas"): ("pandas", "data analysis"),
    ("python", "requests"): ("Requests", "HTTP client"),
    ("python", "httpx"): ("HTTPX", "HTTP client"),
    ("npm", "react"): ("React", "UI library"),
    ("npm", "next"): ("Next.js", "web framework"),
    ("npm", "express"): ("Express", "web framework"),
    ("npm", "vue"): ("Vue", "UI framework"),
    ("npm", "@angular/core"): ("Angular", "UI framework"),
    ("npm", "svelte"): ("Svelte", "UI framework"),
    ("npm", "@nestjs/core"): ("NestJS", "web framework"),
    ("npm", "fastify"): ("Fastify", "web framework"),
    ("npm", "koa"): ("Koa", "web framework"),
    ("npm", "@prisma/client"): ("Prisma", "ORM"),
    ("npm", "mongoose"): ("Mongoose", "ODM"),
    ("npm", "typeorm"): ("TypeORM", "ORM"),
    ("npm", "jest"): ("Jest", "test framework"),
    ("npm", "vitest"): ("Vitest", "test framework"),
    ("npm", "tailwindcss"): ("Tailwind CSS", "styling"),
    ("npm", "vite"): ("Vite", "build tool"),
    ("npm", "typescript"): ("TypeScript", "language tooling"),
    ("npm", "electron"): ("Electron", "desktop framework"),
    ("go", "github.com/gin-gonic/gin"): ("Gin", "web framework"),
    ("go", "github.com/labstack/echo"): ("Echo", "web framework"),
    ("go", "github.com/go-chi/chi"): ("chi", "HTTP router"),
    ("go", "github.com/gorilla/mux"): ("gorilla/mux", "HTTP router"),
    ("go", "gorm.io/gorm"): ("GORM", "ORM"),
    ("go", "github.com/stretchr/testify"): ("testify", "test framework"),
}

# Java imports are package names; frameworks are detected by package prefix.
FRAMEWORK_PREFIXES: dict[tuple[str, str], tuple[str, str]] = {
    ("maven", "org.springframework"): ("Spring", "application framework"),
    ("maven", "jakarta.persistence"): ("Jakarta Persistence", "ORM"),
    ("maven", "javax.persistence"): ("Java Persistence API", "ORM"),
    ("maven", "org.hibernate"): ("Hibernate", "ORM"),
    ("maven", "org.junit"): ("JUnit", "test framework"),
    ("maven", "io.quarkus"): ("Quarkus", "application framework"),
    ("maven", "io.micronaut"): ("Micronaut", "application framework"),
}

_DOCKER_CMD = re.compile(r"^\s*(CMD|ENTRYPOINT|EXPOSE)\s+(.+)$", re.I)


CLASS_KINDS = {"class", "interface", "enum"}
PARSED_LANGUAGES = {"python", "typescript", "javascript", "go", "java"}
ECOSYSTEM = {"python": "python", "typescript": "npm", "javascript": "npm", "go": "go", "java": "maven"}
MAX_DISPATCH_CANDIDATES = 5


@dataclass
class Target:
    """Result of resolving a reference. `via` explains how it was resolved (shown to users)."""

    key: str
    resolution: str  # resolved|ambiguous|external|unresolved
    via: str
    candidates: list[str] = field(default_factory=list)


def _method_for(language: str) -> ExtractionMethod:
    return ExtractionMethod.PYTHON_AST if language == "python" else ExtractionMethod.TREE_SITTER


class SnapshotAnalyzer:
    def __init__(self, session: Session, repo: Repository, snapshot: Snapshot, progress: Callable[[str, str], None] | None = None) -> None:
        self.session = session
        self._report = progress or (lambda stage, message: None)
        self.repo = repo
        self.snapshot = snapshot
        self.root = Path(snapshot.storage_path)
        self.g = GraphBuilder()
        self.stats: Counter[str] = Counter()
        self.findings: list[dict[str, Any]] = []
        self.dependencies: list[dict[str, Any]] = []
        self.symbol_rows: list[dict[str, Any]] = []
        self.ir_rows: list[dict[str, Any]] = []

    # ------------------------------------------------------------------
    def _reusable_ir(self) -> dict[tuple[str, str], dict]:
        """Parse results of earlier snapshots of this repository with the same analyzer version."""
        rows = self.session.execute(
            select(FileAnalysisCache.path, FileAnalysisCache.sha256, FileAnalysisCache.payload)
            .join(Snapshot, Snapshot.id == FileAnalysisCache.snapshot_id)
            .where(
                Snapshot.repository_id == self.repo.id,
                Snapshot.id != self.snapshot.id,
                Snapshot.status == "ready",
                FileAnalysisCache.analyzer_version == ANALYZER_VERSION,
            )
        ).all()
        return {(r.path, r.sha256): r.payload for r in rows}

    def run(self, incremental: bool = True) -> dict[str, Any]:
        files = list(self.session.query(FileRecord).filter(FileRecord.snapshot_id == self.snapshot.id))
        self.files = {f.path: f for f in files}
        analyzed = [f for f in files if f.analyzed]
        contents: dict[str, str] = {}
        for f in analyzed:
            p = resolve_inside(self.root, f.path)
            if p is None:
                continue
            contents[f.path] = p.read_bytes().decode("utf-8", errors="replace")
        lines = {p: c.splitlines() for p, c in contents.items()}
        kinds = {f.path: CATEGORY_TO_SOURCE_KIND.get(f.category, SourceKind.SOURCE) for f in analyzed}
        self.ev = EvidenceCollector(self.snapshot.id, self.repo.id, self.snapshot.commit_sha, lines, kinds, self.snapshot.analyzer_version)
        self.lines = lines

        for f in analyzed:
            self.g.node(file_key(f.path), "file", f.path, f.path, 1, f.line_count or 1, language=f.language, category=f.category)

        # 1. parse code (reusing identical files from earlier snapshots when possible)
        self._report("symbols", f"Extracting symbols from {sum(1 for f in analyzed if f.language in PARSED_LANGUAGES)} source files")
        reusable = self._reusable_ir() if incremental else {}
        analyses: dict[str, FileAnalysis] = {}
        for f in analyzed:
            if f.language in PARSED_LANGUAGES and f.category in ("source", "test") and f.path in contents:
                cached = reusable.get((f.path, f.sha256 or ""))
                if cached is not None:
                    fa = ir_from_dict(cached)
                    self.stats["parsed_files_reused"] += 1
                else:
                    analyzer = next(a for a in ANALYZERS if f.language in a.languages)
                    fa = analyzer.analyze(f.path, contents[f.path].encode("utf-8"))
                    self.stats["parsed_files_fresh"] += 1
                analyses[f.path] = fa
                self.ir_rows.append(
                    {
                        "snapshot_id": self.snapshot.id,
                        "path": f.path,
                        "sha256": f.sha256 or "",
                        "analyzer_version": ANALYZER_VERSION,
                        "language": f.language,
                        "payload": ir_to_dict(fa),
                    }
                )
                self.stats["parsed_files"] += 1
                self.stats[f"parsed_{f.language}"] += 1
                if fa.errors:
                    self.stats["files_with_parse_issues"] += 1
                self.stats["skipped_dynamic_calls"] += fa.skipped_dynamic_calls

        # 2. manifests
        manifests: list[ManifestInfo] = []
        for f in analyzed:
            if f.category == "dependency_manifest":
                m = parse_manifest(f.path, contents[f.path])
                if m is not None:
                    manifests.append(m)
        declared_npm = {d.name for m in manifests for d in m.dependencies if d.ecosystem == "npm"}

        # 3. module index
        index = ModuleIndex({f.path for f in analyzed}, set(self.files))
        index.load_ts_aliases({p: c for p, c in contents.items() if posixpath.basename(p) in ("tsconfig.json", "jsconfig.json")})
        index.load_go_modules({p: c for p, c in contents.items() if posixpath.basename(p) == "go.mod"})
        for path, fa in analyses.items():
            if fa.language == "java":
                index.register_java(path, fa.package, [s.name for s in fa.symbols if s.parent is None])
        self.index = index
        self.analyses = analyses

        # 4. symbols, imports, inheritance (hierarchy first), calls, routes
        self._report("relationships", f"Resolving imports, inheritance and calls across {len(analyses)} parsed files")
        self.bindings: dict[str, dict[str, tuple]] = {}
        self.stars: dict[str, list[str]] = defaultdict(list)
        self.top_symbols: dict[str, dict[str, SymbolInfo]] = {}
        self.sym_kind: dict[str, str] = {}
        self.sym_returns: dict[str, tuple[str, str]] = {}  # symbol key -> (defining path, declared result type)
        self.bases: dict[str, list[str]] = defaultdict(list)
        self.subclasses: dict[str, list[str]] = defaultdict(list)
        self.unresolved_bases: Counter[str] = Counter()
        self._scope_cache: dict[str, dict[str, tuple[str, SymbolInfo]]] = {}
        self.imported_packages: dict[tuple[str, str], list[str]] = defaultdict(list)
        for path, fa in analyses.items():
            self._symbols(path, fa)
        for path, fa in analyses.items():
            self._imports(path, fa)
        for path, fa in analyses.items():
            self._inheritance(path, fa)
        for path, fa in analyses.items():
            self._calls(path, fa)
            self._routes(path, fa, "next" in declared_npm)
            self._entry_points(path, fa)

        # 5. dependencies & frameworks
        self._dependencies(manifests)
        self._frameworks(manifests)

        # 6. documentation, CI, containers, tests
        self._documentation(analyzed, contents)
        self._ops_files(analyzed)

        # 7. persist
        self._report("architecture", f"Building the architecture graph ({len(self.g.nodes)} nodes) and evidence records")
        return self._persist(contents)

    # ------------------------------------------------------------------ symbols
    def _symbols(self, path: str, fa: FileAnalysis) -> None:
        tops: dict[str, SymbolInfo] = {}
        method = _method_for(fa.language)
        for s in fa.symbols:
            eid = self.ev.add(path, s.start_line, s.end_line, EvidenceCategory.SYMBOL_DEFINITION, method, f"{s.kind} {s.qualified_name}")
            key = sym_key(path, s.qualified_name)
            self.g.node(key, s.kind, s.qualified_name, path, s.start_line, s.end_line, exported=s.exported, language=fa.language)
            self.sym_kind[key] = s.kind
            if s.returns:
                self.sym_returns[key] = (path, s.returns)
            parent_key = sym_key(path, s.parent) if s.parent else file_key(path)
            self.g.edge(parent_key, key, "contains", "resolved", eid)
            self.symbol_rows.append(
                {
                    "snapshot_id": self.snapshot.id,
                    "path": path,
                    "kind": s.kind,
                    "name": s.name[:300],
                    "qualified_name": s.qualified_name[:600],
                    "start_line": s.start_line,
                    "end_line": s.end_line,
                    "exported": s.exported or s.name in fa.exports,
                    "signature": s.signature,
                    "docstring": s.docstring,
                    "evidence_id": eid,
                }
            )
            if s.parent is None:
                tops[s.name] = s
            self.stats[f"symbols_{s.kind}"] += 1
        self.top_symbols[path] = tops

    def _scope_tops(self, path: str) -> dict[str, tuple[str, SymbolInfo]]:
        """Names visible without import: the file's top-level symbols, plus (Go/Java) the whole package."""
        if path in self._scope_cache:
            return self._scope_cache[path]
        fa = self.analyses.get(path)
        out: dict[str, tuple[str, SymbolInfo]] = {}
        if fa is not None and fa.language in ("go", "java"):
            directory = posixpath.dirname(path)
            for other, ofa in self.analyses.items():
                if ofa.language == fa.language and posixpath.dirname(other) == directory and ofa.package == fa.package:
                    for name, sym in self.top_symbols.get(other, {}).items():
                        out.setdefault(name, (other, sym))
        for name, sym in self.top_symbols.get(path, {}).items():
            out[name] = (path, sym)
        self._scope_cache[path] = out
        return out

    # ------------------------------------------------------------------ imports
    def _resolve_import(self, path: str, fa: FileAnalysis, spec: str, level: int, imported: str | None) -> Resolution:
        if fa.language == "python":
            return self.index.resolve_python(path, spec, level, imported)
        if fa.language == "go":
            return self.index.resolve_go(spec)
        if fa.language == "java":
            return self.index.resolve_java(spec, star=imported == "*")
        return self.index.resolve_js(path, spec)

    def _imports(self, path: str, fa: FileAnalysis) -> None:
        eco = ECOSYSTEM.get(fa.language, "npm")
        method = _method_for(fa.language)
        binds: dict[str, tuple] = {}
        src = file_key(path)
        for imp in fa.imports:
            label = ("." * imp.level) + imp.spec
            eid = self.ev.add(path, imp.line, imp.end_line, EvidenceCategory.IMPORT, method, f"import {label}")
            self.stats["imports_total"] += 1
            per_name = fa.language == "python" and imp.kind == "from"
            targets: list[tuple[Resolution, Any]] = []
            if per_name:
                for b in imp.bindings:
                    targets.append((self._resolve_import(path, fa, imp.spec, imp.level, b.imported), b))
            else:
                star = any(b.imported == "*" for b in imp.bindings) and fa.language == "java"
                res = self._resolve_import(path, fa, imp.spec, imp.level, "*" if star else None)
                targets = [(res, b) for b in imp.bindings] or [(res, None)]
            for res, b in targets:
                self.stats[f"imports_{res.status}"] += 1
                if res.status == "resolved" and res.target_path:
                    for tgt in (res.candidates or [res.target_path])[:20] if fa.language in ("go", "java") else [res.target_path]:
                        self.g.edge(src, file_key(tgt), "imports", "resolved", eid, spec=label)
                    if b is None:
                        continue
                    if b.local == "*":
                        self.stars[path].extend((res.candidates or [res.target_path]) if fa.language == "java" else [res.target_path])
                    elif fa.language == "go":
                        binds[b.local] = ("gopkg", res.package)
                    else:
                        target_is_module = per_name and res.target_path and _module_matches_name(res.target_path, b.imported)
                        binds[b.local] = ("file", res.target_path, None if target_is_module else b.imported)
                    if fa.language == "python" and imp.kind == "import":
                        # `import a.b` binds `a` and references look like `a.b.x`; `import a.b as c` binds c -> a.b
                        spec_parts = imp.spec.split(".")
                        prefix = spec_parts[1:] if b.local == spec_parts[0] else []
                        binds[b.local] = ("file", res.target_path, None, prefix)
                elif res.status == "ambiguous":
                    for c in (res.candidates or [])[:5]:
                        self.g.edge(src, file_key(c), "imports", "ambiguous", eid, spec=label)
                elif res.status == "external" and res.package:
                    k = self.g.node(pkg_key(eco, res.package), "package", res.package, ecosystem=eco)
                    self.g.edge(src, k, "imports", "external", eid, spec=label)
                    self.imported_packages[(eco, res.package)].append(eid or "")
                    if b is not None and b.local != "*":
                        binds[b.local] = ("pkg", eco, res.package)
                elif res.status == "stdlib":
                    if b is not None:
                        binds[b.local] = ("stdlib", res.package)
                else:
                    k = self.g.node(f"unresolved:import:{label}", "unresolved", label)
                    self.g.edge(src, k, "imports", "unresolved", eid, spec=label)
        self.bindings[path] = binds

    # ------------------------------------------------------------------ hierarchy
    def _inheritance(self, path: str, fa: FileAnalysis) -> None:
        method = _method_for(fa.language)
        for s in fa.symbols:
            if s.kind not in CLASS_KINDS:
                continue
            ckey = sym_key(path, s.qualified_name)
            for base in s.bases:
                t = self._resolve_name(path, base.split("."), "<module>", allow_local_types=False)
                if t is None:
                    self.unresolved_bases[ckey] += 1
                    continue
                if t.resolution == "unresolved":
                    self.g.node(t.key, "unresolved", base)
                if t.resolution == "resolved" and self.sym_kind.get(t.key) in CLASS_KINDS:
                    self.bases[ckey].append(t.key)
                    self.subclasses[t.key].append(ckey)
                else:
                    self.unresolved_bases[ckey] += 1
                eid = self.ev.add(path, s.start_line, s.start_line, EvidenceCategory.SYMBOL_DEFINITION, method, f"class {s.qualified_name} bases")
                self.g.edge(ckey, t.key, "inherits", t.resolution, eid, base=base, via=t.via)

    def _ancestors(self, cls_key: str) -> list[str]:
        """Breadth-first base classes (approximate MRO; cycles guarded)."""
        out: list[str] = []
        queue = list(self.bases.get(cls_key, []))
        while queue and len(out) < 50:
            k = queue.pop(0)
            if k in out or k == cls_key:
                continue
            out.append(k)
            queue.extend(self.bases.get(k, []))
        return out

    def _descendants(self, cls_key: str) -> list[str]:
        out: list[str] = []
        stack = list(self.subclasses.get(cls_key, []))
        while stack and len(out) < 100:
            k = stack.pop()
            if k in out or k == cls_key:
                continue
            out.append(k)
            stack.extend(self.subclasses.get(k, []))
        return out

    @staticmethod
    def _member_key(cls_key: str, name: str) -> str:
        return f"{cls_key}.{name}"

    def _lookup_member(self, cls_key: str, name: str, include_self: bool) -> str | None:
        chain = ([cls_key] if include_self else []) + self._ancestors(cls_key)
        for k in chain:
            mk = self._member_key(k, name)
            if mk in self.g.nodes:
                return mk
        return None

    def _dispatch(self, cls_key: str, name: str, include_self: bool, dynamic: bool) -> Target:
        """Method lookup through the class hierarchy. `dynamic` = receiver is an instance (self/this/typed local)."""
        found = self._lookup_member(cls_key, name, include_self)
        if found is None:
            reason = (
                "possibly_inherited_from_unresolved_base"
                if self.unresolved_bases.get(cls_key) or any(self.unresolved_bases.get(a) for a in self._ancestors(cls_key))
                else "member_not_found"
            )
            return Target(f"unresolved:member:{name}", "unresolved", reason)
        via = "class_member" if found.startswith(cls_key + ".") and include_self else "inheritance"
        if dynamic:
            overrides = [self._member_key(d, name) for d in self._descendants(cls_key)]
            overrides = [o for o in overrides if o in self.g.nodes and o != found]
            if overrides:
                return Target(found, "ambiguous", "dynamic_dispatch", overrides[:MAX_DISPATCH_CANDIDATES])
        return Target(found, "resolved", via)

    def _enclosing_class(self, path: str, caller: str) -> str | None:
        parts = caller.split(".")
        for i in range(len(parts) - 1, 0, -1):
            k = sym_key(path, ".".join(parts[:i]))
            if self.sym_kind.get(k) in CLASS_KINDS:
                return k
        return None

    # ------------------------------------------------------------------ name resolution
    def _caller_key(self, path: str, caller: str) -> str:
        if caller != "<module>":
            k = sym_key(path, caller)
            if k in self.g.nodes:
                return k
        return file_key(path)

    def _resolve_name(self, path: str, parts: list[str], caller: str, allow_local_types: bool = True) -> Target | None:
        """Resolve a dotted reference. Returns None for dynamic receivers we do not attempt to resolve."""
        fa = self.analyses.get(path)
        tops = self._scope_tops(path)
        binds = self.bindings.get(path, {})
        head = parts[0]
        if head in ("self", "this", "cls", "super"):
            cls_key = self._enclosing_class(path, caller)
            if len(parts) == 3 and cls_key and head in ("self", "this"):
                return self._attribute_call(cls_key, parts[1], parts[2])
            if len(parts) == 2 and cls_key:
                return self._dispatch(cls_key, parts[1], include_self=head != "super", dynamic=head in ("self", "this"))
            if len(parts) == 2:
                return Target(f"unresolved:member:{parts[1]}", "unresolved", "no_enclosing_class")
            return None
        if allow_local_types and fa is not None and len(parts) == 2:
            ctor = fa.local_types.get(caller, {}).get(head) or fa.instantiations.get(head)
            if ctor:
                cls_key, via = self._class_for(path, ctor, caller)
                if cls_key:
                    t = self._dispatch(cls_key, parts[1], include_self=True, dynamic=True)
                    if t.resolution == "resolved":
                        t.via = via
                    return t
        if head in tops:
            tpath, sym = tops[head]
            key = sym_key(tpath, sym.qualified_name)
            if len(parts) == 1:
                return Target(key, "resolved", "same_file" if tpath == path else "same_package")
            if sym.kind in CLASS_KINDS and len(parts) == 2:
                return self._dispatch(key, parts[1], include_self=True, dynamic=False)
            return None
        b = binds.get(head)
        if b is not None:
            rest = parts[1:]
            if b[0] == "file" and len(b) > 3 and b[3]:
                prefix = b[3]
                if rest[: len(prefix)] != prefix:
                    return None
                rest = rest[len(prefix) :]
            return self._resolve_binding(b, rest, 0)
        star = self._star_lookup(path, head, parts[1:])
        if star is not None:
            return star
        if len(parts) == 1:
            return Target(f"unresolved:name:{head}", "unresolved", "name_not_found")
        return None

    def _class_for(self, path: str, dotted: str, caller: str = "<module>") -> tuple[str | None, str]:
        """Class a value of type/constructor/factory `dotted` has: the class itself, or (one bounded hop)
        the declared result type of a statically resolved function."""
        t = self._resolve_name(path, dotted.split("."), caller, allow_local_types=False)
        if t is None:
            return None, ""
        if self.sym_kind.get(t.key) in CLASS_KINDS:
            return t.key, "declared_or_constructed_type"
        if t.resolution == "resolved" and t.key in self.sym_returns:
            rpath, rtype = self.sym_returns[t.key]
            rt = self._resolve_name(rpath, rtype.split("."), "<module>", allow_local_types=False)
            if rt is not None and self.sym_kind.get(rt.key) in CLASS_KINDS:
                return rt.key, "declared_return_type"
        return None, ""

    def _attribute_call(self, cls_key: str, attr: str, method: str) -> Target | None:
        """`self.attr.method()` where the attribute's type was recorded in the class (or a base class)."""
        for owner in [cls_key, *self._ancestors(cls_key)]:
            opath, _, oqual = owner[4:].partition("#")
            fa = self.analyses.get(opath)
            typ = fa.local_types.get(f"{oqual}#attrs", {}).get(attr) if fa else None
            if not typ:
                continue
            tcls, _via = self._class_for(opath, typ)
            if tcls is None:
                return None
            t = self._dispatch(tcls, method, include_self=True, dynamic=True)
            if t.resolution == "resolved":
                t.via = "attribute_type"
            return t
        return None

    def _star_lookup(self, path: str, name: str, rest: list[str]) -> Target | None:
        for tgt in self.stars.get(path, []):
            t = self._resolve_binding(("file", tgt, None), [name, *rest], 1)
            if t is not None and t.resolution != "unresolved":
                t.via = "wildcard_import"
                return t
        return None

    def _resolve_binding(self, b: tuple, rest: list[str], depth: int) -> Target | None:
        if b[0] == "pkg":
            return Target(pkg_key(b[1], b[2]), "external", "import")
        if b[0] == "stdlib":
            return None
        if b[0] == "gopkg":
            files = self.index.go_package_files(b[1]) if b[1] is not None else []
            if not files:
                return None
            if not rest:
                return Target(file_key(files[0]), "resolved", "package")
            tops = self._scope_tops(files[0])
            if rest[0] in tops:
                tpath, sym = tops[rest[0]]
                key = sym_key(tpath, sym.qualified_name)
                if len(rest) >= 2 and sym.kind in CLASS_KINDS:
                    return self._dispatch(key, rest[1], include_self=True, dynamic=False)
                return Target(key, "resolved", "package_member")
            return Target(f"unresolved:member:{'.'.join(rest)}", "unresolved", "member_not_found")
        target_path, imported = b[1], b[2]
        tfa = self.analyses.get(target_path)
        if imported == "default":
            default = tfa.default_export if tfa else None
            names = ([default] if default else []) + rest
        else:
            names = ([imported] if imported and imported != "*" else []) + rest
        via = "import" if depth == 0 else "re-export"
        tops = self._scope_tops(target_path)
        if names and names[0] in tops:
            tpath, sym = tops[names[0]]
            key = sym_key(tpath, sym.qualified_name)
            if len(names) >= 2 and sym.kind in CLASS_KINDS:
                t = self._dispatch(key, names[1], include_self=True, dynamic=False)
                if depth and t.resolution == "resolved":
                    t.via = "re-export"
                return t
            return Target(key, "resolved", via)
        if not names:
            return Target(file_key(target_path), "resolved", "module")
        if depth < 4:
            nb = self.bindings.get(target_path, {}).get(names[0])
            t2: Target | None
            if nb is not None:
                t2 = self._resolve_binding(nb, names[1:], depth + 1)
                if t2 is not None and t2.resolution != "unresolved":
                    if t2.resolution == "resolved":
                        t2.via = "re-export"
                    return t2
            for star in self.stars.get(target_path, []):
                t2 = self._resolve_binding(("file", star, None), names, depth + 1)
                if t2 is not None and t2.resolution != "unresolved":
                    if t2.resolution == "resolved":
                        t2.via = "re-export"
                    return t2
        if tfa is not None and tfa.language == "java":  # static member import: a.b.C.member
            for _name, (tpath, sym) in tops.items():
                mk = self._member_key(sym_key(tpath, sym.qualified_name), names[0])
                if sym.kind in CLASS_KINDS and mk in self.g.nodes:
                    return Target(mk, "resolved", "static_import")
        return Target(f"unresolved:member:{'.'.join(names)}", "unresolved", "member_not_found")

    # ------------------------------------------------------------------ calls & routes
    def _calls(self, path: str, fa: FileAnalysis) -> None:
        method = _method_for(fa.language)
        unresolved_budget = MAX_UNRESOLVED_CALL_EDGES_PER_FILE
        for call in fa.calls:
            t = self._resolve_name(path, call.callee.split("."), call.caller)
            if t is None:
                self.stats["calls_dynamic_receiver"] += 1
                continue
            self.stats[f"calls_{t.resolution}"] += 1
            self.stats[f"calls_via_{t.via}"] += 1
            if t.resolution == "unresolved":
                if unresolved_budget <= 0:
                    self.stats["calls_unresolved_not_stored"] += 1
                    continue
                unresolved_budget -= 1
                self.g.node(t.key, "unresolved", t.key.split(":", 2)[-1])
            eid = self.ev.add(path, call.line, call.end_line, EvidenceCategory.CALL, method, f"call {call.callee}")
            src = self._caller_key(path, call.caller)
            self.g.edge(src, t.key, "calls", t.resolution, eid, callee=call.callee, via=t.via, line=call.line)
            for cand in t.candidates:
                self.g.edge(src, cand, "calls", "ambiguous", eid, callee=call.callee, via="possible_override", line=call.line)

    def _routes(self, path: str, fa: FileAnalysis, next_declared: bool) -> None:
        method = _method_for(fa.language)
        for r in fa.routes:
            framework, confidence = r.framework, r.confidence
            if framework == "unknown" and r.receiver:
                b = self.bindings.get(path, {}).get(r.receiver.split(".")[0])
                if b and b[0] == "file":
                    target_fa = self.analyses.get(b[1])
                    ctor = target_fa.instantiations.get(b[2] or r.receiver, "") if target_fa else ""
                    fw = {"FastAPI": "FastAPI", "APIRouter": "FastAPI", "Flask": "Flask", "Blueprint": "Flask"}.get(ctor.split(".")[-1])
                    if fw:
                        framework, confidence = fw, "confirmed"
            if framework == "Next.js":
                if not next_declared:
                    self.stats["nextjs_candidates_without_next_dependency"] += 1
                    continue
                confidence = "confirmed"
            if framework == "Spring":
                if any(i.spec.startswith("org.springframework") for i in fa.imports):
                    confidence = "confirmed"
                else:
                    self.stats["spring_candidates_without_spring_import"] += 1
                    continue
            limitations = [] if confidence == "confirmed" else ["framework attribution not confirmed by static analysis"]
            eid = self.ev.add(path, r.line, r.end_line, EvidenceCategory.ROUTE, method, f"{r.method} {r.path}", limitations)
            rkey = self.g.node(f"route:{r.method} {r.path}@{path}:{r.line}", "route", f"{r.method} {r.path}", path, r.line, r.end_line, framework=framework)
            self.g.edge(file_key(path), rkey, "declares_route", "resolved", eid)
            if r.handler:
                t = self._resolve_name(path, r.handler.split("."), "<module>")
                if t is not None:
                    if t.resolution == "unresolved":
                        self.g.node(t.key, "unresolved", r.handler)
                    self.g.edge(rkey, t.key, "handled_by", t.resolution, eid, via=t.via)
            self.findings.append(
                {
                    "kind": "route",
                    "name": f"{r.method} {r.path}",
                    "detail": {
                        "framework": framework,
                        "path": path,
                        "line": r.line,
                        "handler": r.handler,
                        "method": r.method,
                        "route": r.path,
                        "route_key": rkey,
                    },
                    "evidence_id": eid,
                    "confidence": confidence,
                }
            )
            self.stats["routes"] += 1

    def _entry_points(self, path: str, fa: FileAnalysis) -> None:
        method = _method_for(fa.language)
        for e in fa.entry_points:
            eid = self.ev.add(path, e.line, e.end_line, EvidenceCategory.ENTRY_POINT, method, f"{e.kind} {e.name}")
            node_key = file_key(path)
            if e.kind in ("go_main",):
                node_key = sym_key(path, "main")
            elif e.kind == "java_main":
                node_key = sym_key(path, e.name)
            self.findings.append(
                {
                    "kind": "entry_point",
                    "name": f"{e.kind}: {path}" if e.kind == "python_main_guard" else f"{e.kind}: {e.name}",
                    "detail": {"path": path, "line": e.line, "end_line": e.end_line, "type": e.kind, "node_key": node_key},
                    "evidence_id": eid,
                    "confidence": "confirmed",
                }
            )
        for var, ctor in fa.instantiations.items():
            if ctor.split(".")[-1] in ("FastAPI", "Flask", "express"):
                line = _find_assignment_line(self.lines.get(path, []), var)
                eid = self.ev.add(path, line, line, EvidenceCategory.ENTRY_POINT, method, f"{ctor} application {var}")
                self.findings.append(
                    {
                        "kind": "entry_point",
                        "name": f"{ctor.split('.')[-1]} app `{var}` in {path}",
                        "detail": {"path": path, "line": line, "type": "application_object"},
                        "evidence_id": eid,
                        "confidence": "confirmed",
                    }
                )

    def _dependencies(self, manifests: list[ManifestInfo]) -> None:
        imported_py: dict[str, list[str]] = defaultdict(list)
        imported_npm: dict[str, list[str]] = defaultdict(list)
        imported_prefix: dict[str, list[tuple[str, list[str]]]] = defaultdict(list)  # go/maven
        for (eco, pkg), eids in self.imported_packages.items():
            if eco == "python":
                imported_py[normalize_python_name(PYTHON_IMPORT_TO_DIST.get(pkg, pkg))] += eids
                imported_py[normalize_python_name(pkg)] += eids
            elif eco in ("go", "maven"):
                imported_prefix[eco].append((pkg, eids))
            else:
                imported_npm[pkg] += eids

        def prefix_hits(eco: str, name: str) -> list[str]:
            if eco == "go":
                return [e for p, eids in imported_prefix["go"] if p == name or p.startswith(name + "/") or name.startswith(p + "/") for e in eids]
            group = name.split(":")[0]
            return [e for p, eids in imported_prefix["maven"] if p == group or p.startswith(group + ".") for e in eids]

        declared_keys: set[tuple[str, str]] = set()
        for m in manifests:
            for e in m.errors:
                self.stats["manifest_errors"] += 1
                log.info("manifest %s: %s", m.path, e)
            seen: set[tuple[str, str, str]] = set()
            for d in m.dependencies:
                if (d.ecosystem, d.name.lower(), d.scope) in seen:
                    continue  # same package listed in several groups of one manifest
                seen.add((d.ecosystem, d.name.lower(), d.scope))
                eid = self.ev.add(m.path, d.line, d.line, EvidenceCategory.DEPENDENCY_DECLARATION, ExtractionMethod.MANIFEST_PARSER, f"{d.ecosystem}:{d.name}")
                norm = normalize_python_name(d.name) if d.ecosystem == "python" else d.name
                if d.ecosystem == "python":
                    hits = imported_py.get(norm, [])
                elif d.ecosystem in ("go", "maven"):
                    hits = prefix_hits(d.ecosystem, d.name)
                else:
                    hits = imported_npm.get(norm, [])
                declared_keys.add((d.ecosystem, norm))
                k = self.g.node(pkg_key(d.ecosystem, d.name if d.ecosystem == "npm" else norm), "package", d.name, ecosystem=d.ecosystem)
                self.g.edge(file_key(m.path), k, "declares_dependency", "resolved", eid, scope=d.scope)
                self.dependencies.append(
                    {
                        "snapshot_id": self.snapshot.id,
                        "ecosystem": d.ecosystem,
                        "name": d.name,
                        "specifier": d.specifier,
                        "scope": d.scope,
                        "manifest_path": m.path,
                        "status": "observed_import" if hits else "not_observed",
                        "evidence_id": eid,
                        "import_count": len(hits),
                    }
                )
            for sname, (cmd, line) in m.scripts.items():
                eid = self.ev.add(m.path, line, line, EvidenceCategory.CONFIGURATION, ExtractionMethod.MANIFEST_PARSER, f"script {sname}")
                self.findings.append(
                    {
                        "kind": "script",
                        "name": sname,
                        "detail": {"command": cmd, "manifest": m.path, "line": line},
                        "evidence_id": eid,
                        "confidence": "declared",
                    }
                )
            for kind, value, line in m.entry_points:
                eid = self.ev.add(m.path, line, line, EvidenceCategory.ENTRY_POINT, ExtractionMethod.MANIFEST_PARSER, f"{kind} {value}")
                self.findings.append(
                    {
                        "kind": "entry_point",
                        "name": f"{kind}: {value}",
                        "detail": {"path": m.path, "line": line, "type": kind},
                        "evidence_id": eid,
                        "confidence": "declared",
                    }
                )
            if m.metadata:
                self.findings.append(
                    {
                        "kind": "project_metadata",
                        "name": m.path,
                        "detail": m.metadata,
                        "evidence_id": self.ev.add(
                            m.path,
                            1,
                            min(40, len(self.lines.get(m.path, [])) or 1),
                            EvidenceCategory.CONFIGURATION,
                            ExtractionMethod.MANIFEST_PARSER,
                            "project metadata",
                        ),
                        "confidence": "declared",
                    }
                )
        # undeclared imports
        declared_go = [n for e, n in declared_keys if e == "go"]
        for (eco, pkg), eids in self.imported_packages.items():
            if eco == "maven":
                continue  # Java package names do not map 1:1 to Maven coordinates; make no undeclared claims
            if eco == "go" and any(pkg == n or pkg.startswith(n + "/") or n.startswith(pkg + "/") for n in declared_go):
                continue
            norm = normalize_python_name(PYTHON_IMPORT_TO_DIST.get(pkg, pkg)) if eco == "python" else pkg
            if (eco, norm) in declared_keys or (eco == "python" and (eco, normalize_python_name(pkg)) in declared_keys):
                continue
            # internal top-level package names that we failed to resolve are not dependencies
            if eco == "python" and any(p.split("/")[0] == pkg or f"/{pkg}/" in f"/{p}" for p in self.index.paths if p.endswith(".py")):
                continue
            self.dependencies.append(
                {
                    "snapshot_id": self.snapshot.id,
                    "ecosystem": eco,
                    "name": pkg,
                    "specifier": None,
                    "scope": "undeclared",
                    "manifest_path": None,
                    "status": "undeclared_import",
                    "evidence_id": eids[0] if eids else None,
                    "import_count": len(eids),
                }
            )

    def _frameworks(self, manifests: list[ManifestInfo]) -> None:
        declared: dict[tuple[str, str], str | None] = {}
        for m in manifests:
            for d in m.dependencies:
                key = (d.ecosystem, normalize_python_name(d.name) if d.ecosystem == "python" else d.name)
                declared.setdefault(key, None)
        dep_ev = {
            (d["ecosystem"], normalize_python_name(d["name"]) if d["ecosystem"] == "python" else d["name"]): d["evidence_id"]
            for d in self.dependencies
            if d["scope"] != "undeclared"
        }
        for (eco, prefix), (fw, role) in FRAMEWORK_PREFIXES.items():
            sites = [e for (e2, p), eids in self.imported_packages.items() if e2 == eco and (p == prefix or p.startswith(prefix + ".")) for e in eids]
            if sites:
                self.findings.append(
                    {
                        "kind": "framework",
                        "name": fw,
                        "detail": {"role": role, "ecosystem": eco, "package": prefix, "import_sites": len(sites), "declared": None},
                        "evidence_id": sites[0] or None,
                        "confidence": "observed",
                    }
                )
        for (eco, pkg), (fw, role) in FRAMEWORKS.items():
            imp = self.imported_packages.get((eco, pkg))
            dkey = (eco, pkg)
            if imp:
                self.findings.append(
                    {
                        "kind": "framework",
                        "name": fw,
                        "detail": {"role": role, "ecosystem": eco, "package": pkg, "import_sites": len(imp), "declared": dkey in declared},
                        "evidence_id": imp[0] or None,
                        "confidence": "observed",
                    }
                )
            elif dkey in declared:
                self.findings.append(
                    {
                        "kind": "framework",
                        "name": fw,
                        "detail": {"role": role, "ecosystem": eco, "package": pkg, "import_sites": 0, "declared": True},
                        "evidence_id": dep_ev.get(dkey),
                        "confidence": "declared_only",
                    }
                )

    def _documentation(self, analyzed: list[FileRecord], contents: dict[str, str]) -> None:
        docs = [f for f in analyzed if f.category == "documentation"]
        docs.sort(key=lambda f: (0 if posixpath.basename(f.path).lower().startswith("readme") else 1, f.path.count("/"), f.path))
        budget = 400
        for f in docs:
            for sec in split_sections(f.path, contents[f.path]):
                if budget <= 0:
                    self.stats["doc_sections_not_indexed"] += 1
                    continue
                budget -= 1
                eid = self.ev.add(
                    f.path,
                    sec.start_line,
                    sec.end_line,
                    EvidenceCategory.DOCUMENTATION,
                    ExtractionMethod.DOC_SECTION,
                    sec.title,
                    ["documentation claim; not verified against implementation"],
                )
                self.findings.append(
                    {
                        "kind": "doc_section",
                        "name": sec.title,
                        "detail": {
                            "path": f.path,
                            "start_line": sec.start_line,
                            "end_line": sec.end_line,
                            "level": sec.level,
                            "topic": sec.topic(),
                            "is_readme": posixpath.basename(f.path).lower().startswith("readme"),
                            "chars": len(sec.text),
                        },
                        "evidence_id": eid,
                        "confidence": "documentation",
                    }
                )

    def _ops_files(self, analyzed: list[FileRecord]) -> None:
        for f in analyzed:
            n = len(self.lines.get(f.path, [])) or 1
            if f.category == "ci":
                eid = self.ev.add(f.path, 1, n, EvidenceCategory.CI, ExtractionMethod.INVENTORY, f"ci {f.path}")
                self.findings.append({"kind": "ci", "name": f.path, "detail": {}, "evidence_id": eid, "confidence": "confirmed"})
            elif f.category == "container":
                eid = self.ev.add(f.path, 1, n, EvidenceCategory.CONTAINER, ExtractionMethod.INVENTORY, f"container {f.path}")
                self.findings.append({"kind": "container", "name": f.path, "detail": {}, "evidence_id": eid, "confidence": "confirmed"})
                for i, line in enumerate(self.lines.get(f.path, []), 1):
                    m = _DOCKER_CMD.match(line)
                    if m:
                        ceid = self.ev.add(f.path, i, i, EvidenceCategory.ENTRY_POINT, ExtractionMethod.INVENTORY, f"{m.group(1).upper()} {f.path}:{i}")
                        self.findings.append(
                            {
                                "kind": "entry_point",
                                "name": f"container {m.group(1).upper()}: {m.group(2).strip()[:200]}",
                                "detail": {"path": f.path, "line": i, "type": "container"},
                                "evidence_id": ceid,
                                "confidence": "declared",
                            }
                        )
            elif f.category == "test":
                self.stats["test_files"] += 1

    # ------------------------------------------------------------------
    def _persist(self, contents: dict[str, str]) -> dict[str, Any]:
        sid = self.snapshot.id
        s = self.session
        for model in (Symbol, Evidence, GraphNode, GraphEdge, Dependency, Finding, FileAnalysisCache):
            s.execute(delete(model).where(model.snapshot_id == sid))
        if self.ir_rows:
            s.execute(insert(FileAnalysisCache), self.ir_rows)
        if self.ev.records:
            s.execute(insert(Evidence), list(self.ev.records.values()))
        if self.symbol_rows:
            s.execute(insert(Symbol), self.symbol_rows)
        node_rows = [{"snapshot_id": sid, **n} for n in self.g.nodes.values()]
        edge_rows = [
            {
                "snapshot_id": sid,
                "source_key": src,
                "target_key": dst,
                "kind": kind,
                "resolution": e.resolution,
                "evidence_id": e.evidence_id,
                "attrs": {**e.attrs, "count": e.count},
            }
            for (src, dst, kind), e in self.g.edges.items()
            if src in self.g.nodes and dst in self.g.nodes
        ]
        if node_rows:
            s.execute(insert(GraphNode), node_rows)
        if edge_rows:
            s.execute(insert(GraphEdge), edge_rows)
        if self.dependencies:
            s.execute(insert(Dependency), self.dependencies)
        if self.findings:
            s.execute(insert(Finding), [{"snapshot_id": sid, **f} for f in self.findings])
        indexed = index_files(s, sid, contents)

        g = self.g.to_networkx()
        summary = {
            "stats": dict(self.stats),
            "evidence_records": len(self.ev.records),
            "evidence_rejected": self.ev.rejected,
            "graph": {
                "nodes": g.number_of_nodes(),
                "edges": g.number_of_edges(),
                "edge_kinds": dict(Counter(k for _, _, k in self.g.edges)),
                "edge_resolution": dict(Counter(e.resolution for e in self.g.edges.values())),
            },
            "fts_indexed_files": indexed,
            "central_files": central_files(self.g),
            "most_referenced_symbols": most_referenced(self.g),
        }
        return summary


def _module_matches_name(target_path: str, name: str | None) -> bool:
    if not name:
        return False
    stem = posixpath.splitext(posixpath.basename(target_path))[0]
    if stem == "__init__":
        stem = posixpath.basename(posixpath.dirname(target_path))
    return stem == name


def _find_assignment_line(lines: list[str], var: str) -> int:
    pat = re.compile(rf"^\s*(?:export\s+)?(?:const\s+|let\s+|var\s+)?{re.escape(var)}\s*(?::[^=]+)?=")
    for i, line in enumerate(lines, 1):
        if pat.match(line):
            return i
    return 1
