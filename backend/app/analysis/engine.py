"""Deterministic static analysis of one snapshot.

Produces symbols, a repository graph (files, symbols, packages, routes), dependency
status, framework/entry-point findings, documentation sections and evidence records,
then persists everything for the snapshot.
"""

from __future__ import annotations

import posixpath
import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from sqlalchemy import delete, insert
from sqlalchemy.orm import Session

from app.analysis.docs import split_sections
from app.analysis.ir import FileAnalysis, LanguageAnalyzer, SymbolInfo
from app.analysis.manifests import PYTHON_IMPORT_TO_DIST, ManifestInfo, normalize_python_name, parse_manifest
from app.analysis.python_analyzer import PythonAnalyzer
from app.analysis.resolver import ModuleIndex, Resolution
from app.analysis.ts_analyzer import TypeScriptAnalyzer
from app.core.logging import get_logger
from app.database.models import Dependency, Evidence, FileRecord, Finding, GraphEdge, GraphNode, Repository, Snapshot, Symbol
from app.evidence.collector import EvidenceCollector
from app.evidence.contract import CATEGORY_TO_SOURCE_KIND, EvidenceCategory, ExtractionMethod, SourceKind
from app.graph.builder import GraphBuilder, central_files, file_key, most_referenced, pkg_key, sym_key
from app.ingestion.inventory import resolve_inside
from app.search.fts import index_files

log = get_logger(__name__)

ANALYZERS: list[LanguageAnalyzer] = [PythonAnalyzer(), TypeScriptAnalyzer()]
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
}

_DOCKER_CMD = re.compile(r"^\s*(CMD|ENTRYPOINT|EXPOSE)\s+(.+)$", re.I)


class SnapshotAnalyzer:
    def __init__(self, session: Session, repo: Repository, snapshot: Snapshot) -> None:
        self.session = session
        self.repo = repo
        self.snapshot = snapshot
        self.root = Path(snapshot.storage_path)
        self.g = GraphBuilder()
        self.stats: Counter[str] = Counter()
        self.findings: list[dict[str, Any]] = []
        self.dependencies: list[dict[str, Any]] = []
        self.symbol_rows: list[dict[str, Any]] = []

    # ------------------------------------------------------------------
    def run(self) -> dict[str, Any]:
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
        self.ev = EvidenceCollector(self.snapshot.id, self.repo.id, self.snapshot.commit_sha, lines, kinds)
        self.lines = lines

        for f in analyzed:
            self.g.node(file_key(f.path), "file", f.path, f.path, 1, f.line_count or 1, language=f.language, category=f.category)

        # 1. parse code
        analyses: dict[str, FileAnalysis] = {}
        for f in analyzed:
            if f.language in ("python", "typescript", "javascript") and f.category in ("source", "test"):
                analyzer = next(a for a in ANALYZERS if f.language in a.languages)
                fa = analyzer.analyze(f.path, contents[f.path].encode("utf-8"))
                analyses[f.path] = fa
                self.stats["parsed_files"] += 1
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
        ts_configs = {p: c for p, c in contents.items() if posixpath.basename(p) in ("tsconfig.json", "jsconfig.json")}
        index.load_ts_aliases(ts_configs)
        self.index = index
        self.analyses = analyses

        # 4. symbols, imports, calls, routes
        self.bindings: dict[str, dict[str, tuple]] = {}
        self.top_symbols: dict[str, dict[str, SymbolInfo]] = {}
        self.imported_packages: dict[tuple[str, str], list[str]] = defaultdict(list)  # (eco, pkg) -> evidence ids
        for path, fa in analyses.items():
            self._symbols(path, fa)
        for path, fa in analyses.items():
            self._imports(path, fa)
        for path, fa in analyses.items():
            self._calls(path, fa)
            self._inheritance(path, fa)
            self._routes(path, fa, "next" in declared_npm)
            self._entry_points(path, fa)

        # 5. dependencies & frameworks
        self._dependencies(manifests)
        self._frameworks(manifests)

        # 6. documentation, CI, containers, tests
        self._documentation(analyzed, contents)
        self._ops_files(analyzed)

        # 7. persist
        summary = self._persist(contents)
        return summary

    # ------------------------------------------------------------------
    def _symbols(self, path: str, fa: FileAnalysis) -> None:
        tops: dict[str, SymbolInfo] = {}
        method = ExtractionMethod.PYTHON_AST if fa.language == "python" else ExtractionMethod.TREE_SITTER
        for s in fa.symbols:
            eid = self.ev.add(path, s.start_line, s.end_line, EvidenceCategory.SYMBOL_DEFINITION, method, f"{s.kind} {s.qualified_name}")
            key = sym_key(path, s.qualified_name)
            self.g.node(key, s.kind, s.qualified_name, path, s.start_line, s.end_line, exported=s.exported)
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

    def _resolve_import(self, path: str, fa: FileAnalysis, spec: str, level: int, imported: str | None) -> Resolution:
        if fa.language == "python":
            return self.index.resolve_python(path, spec, level, imported)
        return self.index.resolve_js(path, spec)

    def _imports(self, path: str, fa: FileAnalysis) -> None:
        eco = "python" if fa.language == "python" else "npm"
        method = ExtractionMethod.PYTHON_AST if fa.language == "python" else ExtractionMethod.TREE_SITTER
        binds: dict[str, tuple] = {}
        src = file_key(path)
        for imp in fa.imports:
            label = ("." * imp.level) + imp.spec
            eid = self.ev.add(path, imp.line, imp.end_line, EvidenceCategory.IMPORT, method, f"import {label}")
            self.stats["imports_total"] += 1
            # A python "from x import a, b" may resolve per-name to submodules.
            per_name = fa.language == "python" and imp.kind == "from"
            targets: list[tuple[Resolution, Any]] = []
            if per_name:
                for b in imp.bindings:
                    targets.append((self._resolve_import(path, fa, imp.spec, imp.level, b.imported), b))
            else:
                res = self._resolve_import(path, fa, imp.spec, imp.level, None)
                targets = [(res, b) for b in imp.bindings] or [(res, None)]
            for res, b in targets:
                self.stats[f"imports_{res.status}"] += 1
                if res.status == "resolved" and res.target_path:
                    self.g.edge(src, file_key(res.target_path), "imports", "resolved", eid, spec=label)
                    if b is not None:
                        target_is_module = per_name and res.target_path and _module_matches_name(res.target_path, b.imported)
                        binds[b.local] = ("file", res.target_path, None if target_is_module else b.imported)
                elif res.status == "ambiguous":
                    for c in (res.candidates or [])[:5]:
                        self.g.edge(src, file_key(c), "imports", "ambiguous", eid, spec=label)
                elif res.status == "external" and res.package:
                    k = self.g.node(pkg_key(eco, res.package), "package", res.package, ecosystem=eco)
                    self.g.edge(src, k, "imports", "external", eid, spec=label)
                    self.imported_packages[(eco, res.package)].append(eid or "")
                    if b is not None:
                        binds[b.local] = ("pkg", eco, res.package)
                elif res.status == "stdlib":
                    if b is not None:
                        binds[b.local] = ("stdlib", res.package)
                else:
                    k = self.g.node(f"unresolved:import:{label}", "unresolved", label)
                    self.g.edge(src, k, "imports", "unresolved", eid, spec=label)
                if res.status == "resolved" and b is not None and fa.language == "python" and imp.kind == "import":
                    # `import a.b` binds `a` and references look like `a.b.x`; `import a.b as c` binds c -> a.b
                    spec_parts = imp.spec.split(".")
                    prefix = spec_parts[1:] if b.local == spec_parts[0] else []
                    binds[b.local] = ("file", res.target_path, None, prefix)
        self.bindings[path] = binds

    def _caller_key(self, path: str, caller: str) -> str:
        if caller != "<module>":
            k = sym_key(path, caller)
            if k in self.g.nodes:
                return k
        return file_key(path)

    def _resolve_name(self, path: str, parts: list[str], caller: str) -> tuple[str, str] | None:
        """Return (target_key, resolution) for a dotted reference, or None if it is a dynamic receiver."""
        tops = self.top_symbols.get(path, {})
        binds = self.bindings.get(path, {})
        head = parts[0]
        if head in ("self", "this", "cls") and len(parts) == 2:
            cls = caller.rsplit(".", 1)[0] if "." in caller else None
            if cls:
                k = sym_key(path, f"{cls}.{parts[1]}")
                if k in self.g.nodes:
                    return k, "resolved"
            return f"unresolved:member:{parts[1]}", "unresolved"
        if len(parts) == 1:
            if head in tops:
                return sym_key(path, tops[head].qualified_name), "resolved"
            b = binds.get(head)
            if b is None:
                return f"unresolved:name:{head}", "unresolved"
            return self._resolve_binding(b, [])
        if head in tops and len(parts) == 2 and tops[head].kind == "class":
            k = sym_key(path, f"{head}.{parts[1]}")
            if k in self.g.nodes:
                return k, "resolved"
        b = binds.get(head)
        if b is not None:
            rest = parts[1:]
            if b[0] == "file" and len(b) > 3 and b[3]:
                prefix = b[3]
                if rest[: len(prefix)] != prefix:
                    return None
                rest = rest[len(prefix) :]
            return self._resolve_binding(b, rest)
        return None

    def _resolve_binding(self, b: tuple, rest: list[str]) -> tuple[str, str] | None:
        if b[0] == "pkg":
            return pkg_key(b[1], b[2]), "external"
        if b[0] == "stdlib":
            return None
        target_path, imported = b[1], b[2]
        names = ([imported] if imported and imported not in ("default", "*") else []) + rest
        tops = self.top_symbols.get(target_path, {})
        if names and names[0] in tops:
            sym = tops[names[0]]
            if len(names) >= 2 and sym.kind == "class":
                k = sym_key(target_path, f"{sym.qualified_name}.{names[1]}")
                if k in self.g.nodes:
                    return k, "resolved"
            return sym_key(target_path, sym.qualified_name), "resolved"
        if not names:
            return file_key(target_path), "resolved"
        return f"unresolved:member:{'.'.join(names)}", "unresolved"

    def _calls(self, path: str, fa: FileAnalysis) -> None:
        method = ExtractionMethod.PYTHON_AST if fa.language == "python" else ExtractionMethod.TREE_SITTER
        unresolved_budget = MAX_UNRESOLVED_CALL_EDGES_PER_FILE
        for call in fa.calls:
            parts = call.callee.split(".")
            target = self._resolve_name(path, parts, call.caller)
            if target is None:
                self.stats["calls_dynamic_receiver"] += 1
                continue
            tkey, resolution = target
            self.stats[f"calls_{resolution}"] += 1
            if resolution == "unresolved":
                if unresolved_budget <= 0:
                    self.stats["calls_unresolved_not_stored"] += 1
                    continue
                unresolved_budget -= 1
                self.g.node(tkey, "unresolved", tkey.split(":", 2)[-1])
            eid = self.ev.add(path, call.line, call.end_line, EvidenceCategory.CALL, method, f"call {call.callee}")
            self.g.edge(self._caller_key(path, call.caller), tkey, "calls", resolution, eid, callee=call.callee)

    def _inheritance(self, path: str, fa: FileAnalysis) -> None:
        method = ExtractionMethod.PYTHON_AST if fa.language == "python" else ExtractionMethod.TREE_SITTER
        for s in fa.symbols:
            if s.kind != "class":
                continue
            for base in s.bases:
                target = self._resolve_name(path, base.split("."), "<module>")
                if target is None:
                    continue
                tkey, resolution = target
                if resolution == "unresolved":
                    self.g.node(tkey, "unresolved", base)
                eid = self.ev.add(path, s.start_line, s.start_line, EvidenceCategory.SYMBOL_DEFINITION, method, f"class {s.qualified_name} bases")
                self.g.edge(sym_key(path, s.qualified_name), tkey, "inherits", resolution, eid, base=base)

    def _routes(self, path: str, fa: FileAnalysis, next_declared: bool) -> None:
        method = ExtractionMethod.PYTHON_AST if fa.language == "python" else ExtractionMethod.TREE_SITTER
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
            limitations = [] if confidence == "confirmed" else ["framework attribution not confirmed by static analysis"]
            eid = self.ev.add(path, r.line, r.end_line, EvidenceCategory.ROUTE, method, f"{r.method} {r.path}", limitations)
            rkey = self.g.node(f"route:{r.method} {r.path}@{path}:{r.line}", "route", f"{r.method} {r.path}", path, r.line, r.end_line, framework=framework)
            self.g.edge(file_key(path), rkey, "declares_route", "resolved", eid)
            if r.handler:
                target = self._resolve_name(path, r.handler.split("."), "<module>")
                if target:
                    if target[1] == "unresolved":
                        self.g.node(target[0], "unresolved", r.handler)
                    self.g.edge(rkey, target[0], "handled_by", target[1], eid)
            self.findings.append(
                {
                    "kind": "route",
                    "name": f"{r.method} {r.path}",
                    "detail": {"framework": framework, "path": path, "line": r.line, "handler": r.handler, "method": r.method, "route": r.path},
                    "evidence_id": eid,
                    "confidence": confidence,
                }
            )
            self.stats["routes"] += 1

    def _entry_points(self, path: str, fa: FileAnalysis) -> None:
        method = ExtractionMethod.PYTHON_AST if fa.language == "python" else ExtractionMethod.TREE_SITTER
        for e in fa.entry_points:
            eid = self.ev.add(path, e.line, e.end_line, EvidenceCategory.ENTRY_POINT, method, f"{e.kind} {e.name}")
            self.findings.append(
                {
                    "kind": "entry_point",
                    "name": f"{e.kind}: {path}" if e.kind == "python_main_guard" else f"{e.kind}: {e.name}",
                    "detail": {"path": path, "line": e.line, "type": e.kind},
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
        for (eco, pkg), eids in self.imported_packages.items():
            if eco == "python":
                imported_py[normalize_python_name(PYTHON_IMPORT_TO_DIST.get(pkg, pkg))] += eids
                imported_py[normalize_python_name(pkg)] += eids
            else:
                imported_npm[pkg] += eids
        declared_keys: set[tuple[str, str]] = set()
        for m in manifests:
            for e in m.errors:
                self.stats["manifest_errors"] += 1
                log.info("manifest %s: %s", m.path, e)
            for d in m.dependencies:
                eid = self.ev.add(m.path, d.line, d.line, EvidenceCategory.DEPENDENCY_DECLARATION, ExtractionMethod.MANIFEST_PARSER, f"{d.ecosystem}:{d.name}")
                norm = normalize_python_name(d.name) if d.ecosystem == "python" else d.name
                hits = imported_py.get(norm, []) if d.ecosystem == "python" else imported_npm.get(norm, [])
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
        for (eco, pkg), eids in self.imported_packages.items():
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
        for model in (Symbol, Evidence, GraphNode, GraphEdge, Dependency, Finding):
            s.execute(delete(model).where(model.snapshot_id == sid))
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
