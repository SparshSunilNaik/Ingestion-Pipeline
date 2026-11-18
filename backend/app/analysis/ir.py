"""Language-neutral intermediate representation produced by per-language analyzers."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Protocol


@dataclass
class SymbolInfo:
    kind: str  # function|class|method|interface|type|enum|variable
    name: str
    qualified_name: str
    start_line: int
    end_line: int
    exported: bool = False
    signature: str | None = None
    docstring: str | None = None
    parent: str | None = None  # qualified name of enclosing class
    bases: list[str] = field(default_factory=list)
    returns: str | None = None  # declared result type (dotted name), when statically known


@dataclass
class ImportBinding:
    local: str  # name bound in the importing module ("*" for star imports)
    imported: str | None  # name imported from the module (None = whole module / namespace)


@dataclass
class ImportInfo:
    spec: str  # module specifier as written ("os.path", "./util", "react")
    line: int
    end_line: int
    level: int = 0  # python relative-import level
    bindings: list[ImportBinding] = field(default_factory=list)
    kind: str = "import"  # import|from|esm|require|dynamic|reexport


@dataclass
class CallInfo:
    callee: str  # dotted callee text: "foo", "self.bar", "os.path.join"
    caller: str  # qualified name of enclosing function/method or "<module>"
    line: int
    end_line: int


@dataclass
class RouteInfo:
    framework: str
    method: str
    path: str
    handler: str | None
    line: int
    end_line: int
    receiver: str | None = None
    confidence: str = "confirmed"  # confirmed|probable


@dataclass
class EntryPointInfo:
    kind: str
    name: str
    line: int
    end_line: int


@dataclass
class FileAnalysis:
    path: str
    language: str
    symbols: list[SymbolInfo] = field(default_factory=list)
    imports: list[ImportInfo] = field(default_factory=list)
    calls: list[CallInfo] = field(default_factory=list)
    routes: list[RouteInfo] = field(default_factory=list)
    exports: list[str] = field(default_factory=list)
    entry_points: list[EntryPointInfo] = field(default_factory=list)
    instantiations: dict[str, str] = field(default_factory=dict)  # module-level var -> constructor name
    # callable qualified name -> {local variable -> constructor dotted name}; static, flow-insensitive
    local_types: dict[str, dict[str, str]] = field(default_factory=dict)
    default_export: str | None = None  # JS/TS: name of the symbol exported as default
    package: str | None = None  # Go/Java package name
    errors: list[str] = field(default_factory=list)
    skipped_dynamic_calls: int = 0


class LanguageAnalyzer(Protocol):
    languages: frozenset[str]

    def analyze(self, path: str, source: bytes) -> FileAnalysis: ...


def ir_to_dict(fa: FileAnalysis) -> dict:
    return asdict(fa)


def ir_from_dict(d: dict) -> FileAnalysis:
    return FileAnalysis(
        path=d["path"],
        language=d["language"],
        symbols=[SymbolInfo(**s) for s in d.get("symbols", [])],
        imports=[ImportInfo(**{**i, "bindings": [ImportBinding(**b) for b in i.get("bindings", [])]}) for i in d.get("imports", [])],
        calls=[CallInfo(**c) for c in d.get("calls", [])],
        routes=[RouteInfo(**r) for r in d.get("routes", [])],
        exports=list(d.get("exports", [])),
        entry_points=[EntryPointInfo(**e) for e in d.get("entry_points", [])],
        instantiations=dict(d.get("instantiations", {})),
        local_types={k: dict(v) for k, v in d.get("local_types", {}).items()},
        default_export=d.get("default_export"),
        package=d.get("package"),
        errors=list(d.get("errors", [])),
        skipped_dynamic_calls=int(d.get("skipped_dynamic_calls", 0)),
    )
