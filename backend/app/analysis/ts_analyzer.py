"""TypeScript / JavaScript analyzer based on Tree-sitter grammars."""

from __future__ import annotations

import posixpath
import re
from functools import lru_cache

import tree_sitter_javascript as ts_js
import tree_sitter_typescript as ts_ts
from tree_sitter import Language, Node, Parser

from app.analysis.ir import (
    CallInfo,
    EntryPointInfo,
    FileAnalysis,
    ImportBinding,
    ImportInfo,
    RouteInfo,
    SymbolInfo,
)

_HTTP_METHODS = {"get", "post", "put", "delete", "patch", "options", "head", "all", "use"}
_NEXT_ROUTE_EXPORTS = {"GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"}
_JS_GLOBALS = {
    "console",
    "Math",
    "JSON",
    "Object",
    "Array",
    "Promise",
    "String",
    "Number",
    "Boolean",
    "Date",
    "Error",
    "Symbol",
    "Map",
    "Set",
    "WeakMap",
    "RegExp",
    "Reflect",
    "window",
    "document",
    "globalThis",
    "process",
    "setTimeout",
    "setInterval",
    "clearTimeout",
    "clearInterval",
    "parseInt",
    "parseFloat",
    "fetch",
    "require",
    "encodeURIComponent",
    "decodeURIComponent",
    "isNaN",
    "structuredClone",
    "queueMicrotask",
    "Buffer",
    "URL",
    "URLSearchParams",
    "Intl",
    "BigInt",
    "alert",
    "localStorage",
    "sessionStorage",
}
MAX_SOURCE_BYTES = 2_000_000
_MAX_DEPTH = 400


@lru_cache(maxsize=4)
def _parser(dialect: str) -> Parser:
    if dialect == "tsx":
        lang = Language(ts_ts.language_tsx())
    elif dialect == "typescript":
        lang = Language(ts_ts.language_typescript())
    else:
        lang = Language(ts_js.language())
    return Parser(lang)


def dialect_for(path: str) -> str:
    ext = posixpath.splitext(path.lower())[1]
    if ext == ".tsx":
        return "tsx"
    if ext in (".ts", ".mts", ".cts"):
        return "typescript"
    return "javascript"


def _text(node: Node | None) -> str:
    if node is None or node.text is None:
        return ""
    return node.text.decode("utf-8", errors="replace")


def _line(node: Node) -> int:
    return node.start_point[0] + 1


def _end_line(node: Node) -> int:
    return node.end_point[0] + 1


def _string_value(node: Node | None) -> str | None:
    if node is None:
        return None
    if node.type == "string":
        raw = _text(node)
        if len(raw) >= 2 and raw[0] in "'\"" and raw[-1] == raw[0]:
            return raw[1:-1]
    if node.type == "template_string" and not any(c.type == "template_substitution" for c in node.children):
        return _text(node)[1:-1]
    return None


def _member_chain(node: Node) -> str | None:
    if node.type in ("identifier", "this", "property_identifier", "super"):
        return _text(node)
    if node.type == "member_expression":
        obj = node.child_by_field_name("object")
        prop = node.child_by_field_name("property")
        if obj is None or prop is None:
            return None
        base = _member_chain(obj)
        return f"{base}.{_text(prop)}" if base else None
    return None


class _Walker:
    def __init__(self, result: FileAnalysis) -> None:
        self.r = result
        self.scope: list[tuple[str, str]] = []
        self.express_receivers: set[str] = set()

    def qual(self, name: str) -> str:
        return ".".join([s[1] for s in self.scope] + [name])

    def current_callable(self) -> str:
        for i in range(len(self.scope) - 1, -1, -1):
            if self.scope[i][0] == "function":
                return ".".join(s[1] for s in self.scope[: i + 1])
        return "<module>"

    def enclosing_class(self) -> str | None:
        if self.scope and self.scope[-1][0] == "class":
            return ".".join(s[1] for s in self.scope)
        return None

    def add_symbol(self, kind: str, name: str, node: Node, exported: bool, bases: list[str] | None = None) -> str:
        qual = self.qual(name)
        first_line = _text(node).splitlines()[0] if node.text else ""
        self.r.symbols.append(
            SymbolInfo(
                kind=kind,
                name=name,
                qualified_name=qual,
                start_line=_line(node),
                end_line=_end_line(node),
                exported=exported,
                signature=first_line[:300],
                parent=self.enclosing_class(),
                bases=bases or [],
            )
        )
        if exported and not self.scope:
            self.r.exports.append(name)
        return qual

    def walk(self, node: Node, exported: bool = False, depth: int = 0) -> None:
        if depth > _MAX_DEPTH:
            self.r.errors.append("max_depth")
            return
        t = node.type
        handler = getattr(self, f"on_{t}", None)
        if handler is not None and handler(node, exported, depth):
            return
        for child in node.children:
            self.walk(child, False, depth + 1)

    # --- declarations --------------------------------------------------------
    def _function_like(self, node: Node, name: str, exported: bool, depth: int, kind: str = "function") -> bool:
        cls = self.enclosing_class()
        self.add_symbol("method" if cls else kind, name, node, exported)
        self.scope.append(("function", name))
        body = node.child_by_field_name("body")
        for child in body.children if body is not None else node.children:
            self.walk(child, False, depth + 1)
        self.scope.pop()
        return True

    def on_function_declaration(self, node: Node, exported: bool, depth: int) -> bool:
        name = _text(node.child_by_field_name("name")) or "<anonymous>"
        return self._function_like(node, name, exported, depth)

    on_generator_function_declaration = on_function_declaration

    def on_class_declaration(self, node: Node, exported: bool, depth: int) -> bool:
        name = _text(node.child_by_field_name("name")) or "<anonymous>"
        bases: list[str] = []
        for c in node.children:
            if c.type == "class_heritage":
                for h in c.children:
                    if h.type == "extends_clause":
                        val = h.child_by_field_name("value") or (h.named_children[0] if h.named_children else None)
                        chain = _member_chain(val) if val is not None else None
                        if chain:
                            bases.append(chain)
                    elif h.type in ("identifier", "member_expression"):
                        chain = _member_chain(h)
                        if chain:
                            bases.append(chain)
        self.add_symbol("class", name, node, exported, bases)
        self.scope.append(("class", name))
        body = node.child_by_field_name("body")
        if body is not None:
            for child in body.children:
                self.walk(child, False, depth + 1)
        self.scope.pop()
        return True

    on_abstract_class_declaration = on_class_declaration

    def on_method_definition(self, node: Node, exported: bool, depth: int) -> bool:
        name = _text(node.child_by_field_name("name")) or "<anonymous>"
        return self._function_like(node, name, False, depth, kind="method")

    def on_interface_declaration(self, node: Node, exported: bool, depth: int) -> bool:
        self.add_symbol("interface", _text(node.child_by_field_name("name")), node, exported)
        return True

    def on_type_alias_declaration(self, node: Node, exported: bool, depth: int) -> bool:
        self.add_symbol("type", _text(node.child_by_field_name("name")), node, exported)
        return True

    def on_enum_declaration(self, node: Node, exported: bool, depth: int) -> bool:
        self.add_symbol("enum", _text(node.child_by_field_name("name")), node, exported)
        return True

    def _declarators(self, node: Node, exported: bool, depth: int) -> bool:
        handled_any = False
        for decl in node.named_children:
            if decl.type != "variable_declarator":
                continue
            name_node = decl.child_by_field_name("name")
            value = decl.child_by_field_name("value")
            if name_node is None or name_node.type != "identifier":
                if value is not None:
                    self.walk(value, False, depth + 1)
                    handled_any = True
                continue
            name = _text(name_node)
            if value is not None and value.type in ("arrow_function", "function_expression", "function", "generator_function"):
                handled_any = True
                cls = self.enclosing_class()
                self.add_symbol("method" if cls else "function", name, node if len(node.named_children) == 1 else decl, exported)
                self.scope.append(("function", name))
                for child in value.children:
                    self.walk(child, False, depth + 1)
                self.scope.pop()
                continue
            if self.scope and value is not None and value.type == "new_expression":
                ctor = _member_chain(value.child_by_field_name("constructor") or value)
                if ctor:
                    self.r.local_types.setdefault(self.current_callable(), {})[name] = ctor
            if not self.scope:
                if exported:
                    self.add_symbol("variable", name, decl, exported)
                if value is not None and value.type == "new_expression":
                    ctor = _member_chain(value.child_by_field_name("constructor") or value)
                    if ctor:
                        self.r.instantiations[name] = ctor  # module-level `const x = new C()` types x everywhere in the file
                if value is not None and value.type == "call_expression":
                    fn = _member_chain(value.child_by_field_name("function") or value)
                    if fn:
                        self.r.instantiations[name] = fn
                        if fn in ("express", "express.Router", "Router"):
                            self.express_receivers.add(name)
            if value is not None:
                self.walk(value, False, depth + 1)
                handled_any = True
        return handled_any

    def on_lexical_declaration(self, node: Node, exported: bool, depth: int) -> bool:
        self._declarators(node, exported, depth)
        return True

    on_variable_declaration = on_lexical_declaration

    def on_export_statement(self, node: Node, exported: bool, depth: int) -> bool:
        decl = node.child_by_field_name("declaration")
        source = node.child_by_field_name("source")
        is_default = any(c.type == "default" for c in node.children)
        if source is not None:
            spec = _string_value(source)
            if spec is not None:
                bindings: list[ImportBinding] = []
                for c in node.named_children:
                    if c.type == "export_clause":
                        for s in c.named_children:
                            if s.type == "export_specifier":
                                n = _text(s.child_by_field_name("name"))
                                a = _text(s.child_by_field_name("alias")) or n
                                bindings.append(ImportBinding(local=a, imported=n))
                                self.r.exports.append(a)
                if not bindings:
                    bindings.append(ImportBinding(local="*", imported="*"))
                self.r.imports.append(ImportInfo(spec=spec, line=_line(node), end_line=_end_line(node), bindings=bindings, kind="reexport"))
            return True
        if decl is not None:
            self.walk(decl, True, depth + 1)
            if is_default:
                self.r.exports.append("default")
                dname = decl.child_by_field_name("name")
                if dname is not None:
                    self.r.default_export = _text(dname)
            return True
        for c in node.named_children:
            if c.type == "export_clause":
                for s in c.named_children:
                    if s.type == "export_specifier":
                        self.r.exports.append(_text(s.child_by_field_name("alias")) or _text(s.child_by_field_name("name")))
            elif is_default:
                self.r.exports.append("default")
                if c.type == "identifier":
                    self.r.default_export = _text(c)
                if c.type in ("function_expression", "function", "arrow_function", "class"):
                    name = _text(c.child_by_field_name("name")) or "default"
                    self.r.default_export = name
                    if c.type == "class":
                        self.add_symbol("class", name, c, True)
                    else:
                        self._function_like(c, name, True, depth)
                    return True
                self.walk(c, False, depth + 1)
        return True

    def on_import_statement(self, node: Node, exported: bool, depth: int) -> bool:
        spec = _string_value(node.child_by_field_name("source"))
        if spec is None:
            return True
        bindings: list[ImportBinding] = []
        for c in node.named_children:
            if c.type != "import_clause":
                continue
            for part in c.named_children:
                if part.type == "identifier":
                    bindings.append(ImportBinding(local=_text(part), imported="default"))
                elif part.type == "namespace_import":
                    ids = [x for x in part.named_children if x.type == "identifier"]
                    if ids:
                        bindings.append(ImportBinding(local=_text(ids[0]), imported=None))
                elif part.type == "named_imports":
                    for s in part.named_children:
                        if s.type == "import_specifier":
                            n = _text(s.child_by_field_name("name"))
                            a = _text(s.child_by_field_name("alias")) or n
                            bindings.append(ImportBinding(local=a, imported=n))
        self.r.imports.append(ImportInfo(spec=spec, line=_line(node), end_line=_end_line(node), bindings=bindings, kind="esm"))
        return True

    # --- expressions ---------------------------------------------------------
    def on_call_expression(self, node: Node, exported: bool, depth: int) -> bool:
        fn = node.child_by_field_name("function")
        args = node.child_by_field_name("arguments")
        if fn is None:
            return False
        if fn.type == "import":
            spec = _string_value(args.named_children[0]) if args is not None and args.named_children else None
            if spec:
                self.r.imports.append(ImportInfo(spec=spec, line=_line(node), end_line=_end_line(node), kind="dynamic"))
            return False
        chain = _member_chain(fn)
        if chain is None:
            self.r.skipped_dynamic_calls += 1
            return False
        if chain == "require" and args is not None and args.named_children:
            spec = _string_value(args.named_children[0])
            if spec:
                local = None
                parent = node.parent
                if parent is not None and parent.type == "variable_declarator":
                    nm = parent.child_by_field_name("name")
                    if nm is not None and nm.type == "identifier":
                        local = _text(nm)
                bindings = [ImportBinding(local=local, imported=None)] if local else []
                self.r.imports.append(ImportInfo(spec=spec, line=_line(node), end_line=_end_line(node), bindings=bindings, kind="require"))
            return False
        root = chain.split(".")[0]
        if root not in _JS_GLOBALS:
            self.r.calls.append(CallInfo(callee=chain, caller=self.current_callable(), line=_line(node), end_line=_end_line(node)))
        # Express-style route registration: app.get("/path", handler)
        if fn.type == "member_expression" and args is not None:
            obj = fn.child_by_field_name("object")
            prop = _text(fn.child_by_field_name("property"))
            receiver = _member_chain(obj) if obj is not None else None
            if prop in _HTTP_METHODS and receiver in self.express_receivers and args.named_children:
                path = _string_value(args.named_children[0])
                if path is not None:
                    handler = None
                    if len(args.named_children) > 1:
                        handler = _member_chain(args.named_children[-1])
                    self.r.routes.append(
                        RouteInfo(
                            framework="Express", method=prop.upper(), path=path, handler=handler, line=_line(node), end_line=_end_line(node), receiver=receiver
                        )
                    )
        return False

    def on_new_expression(self, node: Node, exported: bool, depth: int) -> bool:
        ctor = node.child_by_field_name("constructor")
        chain = _member_chain(ctor) if ctor is not None else None
        if chain and chain.split(".")[0] not in _JS_GLOBALS:
            self.r.calls.append(CallInfo(callee=chain, caller=self.current_callable(), line=_line(node), end_line=_end_line(node)))
        return False

    def on_assignment_expression(self, node: Node, exported: bool, depth: int) -> bool:
        left = node.child_by_field_name("left")
        chain = _member_chain(left) if left is not None else None
        if chain == "module.exports":
            self.r.exports.append("module.exports")
        elif chain and chain.startswith("exports.") and chain.count(".") == 1:
            self.r.exports.append(chain.split(".", 1)[1])
        elif chain and chain.startswith("module.exports.") and chain.count(".") == 2:
            self.r.exports.append(chain.split(".")[2])
        return False


_NEXT_APP_ROUTE = re.compile(r"(^|/)app/(?:(.*)/)?route\.(?:[mc]?[jt]sx?)$")
_NEXT_APP_PAGE = re.compile(r"(^|/)app/(?:(.*)/)?page\.(?:[jt]sx?)$")
_NEXT_PAGES_API = re.compile(r"(^|/)pages/api/(.+)\.(?:[jt]sx?)$")


def _next_segment_path(raw: str | None) -> str:
    if not raw:
        return "/"
    segs = [s for s in raw.split("/") if not (s.startswith("(") and s.endswith(")")) and not s.startswith("@")]
    return "/" + "/".join(segs)


class TypeScriptAnalyzer:
    languages = frozenset({"typescript", "javascript"})

    def analyze(self, path: str, source: bytes) -> FileAnalysis:
        dialect = dialect_for(path)
        result = FileAnalysis(path=path, language="typescript" if dialect != "javascript" else "javascript")
        if len(source) > MAX_SOURCE_BYTES:
            result.errors.append("source_too_large")
            return result
        tree = _parser(dialect).parse(source)
        if tree.root_node.has_error:
            result.errors.append("syntax_errors_present")
        walker = _Walker(result)
        walker.walk(tree.root_node)
        self._next_conventions(path, result)
        return result

    @staticmethod
    def _next_conventions(path: str, result: FileAnalysis) -> None:
        """Record Next.js file-convention candidates; they are confirmed only if `next` is a declared dependency."""
        m = _NEXT_APP_ROUTE.search(path)
        if m:
            route_path = _next_segment_path(m.group(2))
            for sym in result.symbols:
                if sym.name in _NEXT_ROUTE_EXPORTS and sym.exported and sym.parent is None:
                    result.routes.append(
                        RouteInfo(
                            framework="Next.js",
                            method=sym.name,
                            path=route_path,
                            handler=sym.qualified_name,
                            line=sym.start_line,
                            end_line=sym.end_line,
                            confidence="candidate",
                        )
                    )
        m = _NEXT_APP_PAGE.search(path)
        if m and "default" in result.exports:
            result.entry_points.append(EntryPointInfo(kind="nextjs_page", name=_next_segment_path(m.group(2)), line=1, end_line=1))
        m = _NEXT_PAGES_API.search(path)
        if m and "default" in result.exports:
            result.routes.append(
                RouteInfo(
                    framework="Next.js",
                    method="ANY",
                    path="/api/" + m.group(2).removesuffix("/index"),
                    handler="default",
                    line=1,
                    end_line=1,
                    confidence="candidate",
                )
            )
