"""Go analyzer (Tree-sitter). Packages, imports, functions, methods, types, calls, routes.

Limitations (documented): no type checking; interface satisfaction is not computed; generic
instantiation, goroutine/channel flow and reflection are not modelled. Method calls on values
are resolved only through the method receiver (`r.m()` inside a method of `r`'s type).
"""

from __future__ import annotations

from functools import lru_cache

import tree_sitter_go as ts_go
from tree_sitter import Language, Node, Parser

from app.analysis.ir import CallInfo, EntryPointInfo, FileAnalysis, ImportBinding, ImportInfo, RouteInfo, SymbolInfo

MAX_SOURCE_BYTES = 2_000_000
_ROUTER_CTORS = {
    "gin.Default": "Gin",
    "gin.New": "Gin",
    "echo.New": "Echo",
    "chi.NewRouter": "chi",
    "mux.NewRouter": "gorilla/mux",
    "http.NewServeMux": "net/http",
}
_HTTP_METHODS = {"GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "Get", "Post", "Put", "Delete", "Patch", "Handle", "HandleFunc", "Any"}
_BUILTINS = {
    "len",
    "cap",
    "make",
    "new",
    "append",
    "copy",
    "delete",
    "panic",
    "recover",
    "print",
    "println",
    "close",
    "min",
    "max",
    "clear",
    "complex",
    "real",
    "imag",
}


@lru_cache(maxsize=1)
def _parser() -> Parser:
    return Parser(Language(ts_go.language()))


def _t(n: Node | None) -> str:
    return n.text.decode("utf-8", errors="replace") if n is not None and n.text is not None else ""


def _chain(n: Node | None) -> str | None:
    if n is None:
        return None
    if n.type in ("identifier", "field_identifier", "package_identifier", "type_identifier"):
        return _t(n)
    if n.type == "selector_expression":
        base = _chain(n.child_by_field_name("operand"))
        field = n.child_by_field_name("field")
        return f"{base}.{_t(field)}" if base and field is not None else None
    return None


def _str(n: Node | None) -> str | None:
    if n is not None and n.type in ("interpreted_string_literal", "raw_string_literal"):
        return _t(n)[1:-1]
    return None


def _receiver_type(n: Node | None) -> tuple[str | None, str | None]:
    """(receiver variable, receiver type name) from a method receiver parameter list."""
    if n is None:
        return None, None
    for p in n.named_children:
        if p.type == "parameter_declaration":
            name = p.child_by_field_name("name")
            typ = p.child_by_field_name("type")
            while typ is not None and typ.type in ("pointer_type", "generic_type"):
                typ = typ.named_children[0] if typ.named_children else None
            return (_t(name) or None), (_t(typ) or None)
    return None, None


class GoAnalyzer:
    languages = frozenset({"go"})

    def analyze(self, path: str, source: bytes) -> FileAnalysis:
        r = FileAnalysis(path=path, language="go")
        if len(source) > MAX_SOURCE_BYTES:
            r.errors.append("source_too_large")
            return r
        root = _parser().parse(source).root_node
        if root.has_error:
            r.errors.append("syntax_errors_present")
        router_vars: dict[str, str] = {}
        for node in root.named_children:
            if node.type == "package_clause":
                r.package = _t(node.named_children[0]) if node.named_children else None
            elif node.type == "import_declaration":
                specs = [c for c in node.named_children if c.type == "import_spec"]
                for lst in (c for c in node.named_children if c.type == "import_spec_list"):
                    specs += [c for c in lst.named_children if c.type == "import_spec"]
                for spec in specs:
                    ipath = _str(spec.child_by_field_name("path"))
                    if ipath is None:
                        continue
                    alias = spec.child_by_field_name("name")
                    local = _t(alias) if alias is not None else ipath.rsplit("/", 1)[-1]
                    r.imports.append(
                        ImportInfo(
                            spec=ipath,
                            line=spec.start_point[0] + 1,
                            end_line=spec.end_point[0] + 1,
                            bindings=[ImportBinding(local=local, imported=None)],
                            kind="import",
                        )
                    )
            elif node.type == "function_declaration":
                name = _t(node.child_by_field_name("name"))
                self._symbol(r, "function", name, name, node, None)
                if name == "main" and r.package == "main":
                    r.entry_points.append(EntryPointInfo(kind="go_main", name=f"{path}:main", line=node.start_point[0] + 1, end_line=node.end_point[0] + 1))
                self._walk_body(r, node.child_by_field_name("body"), name, None, router_vars)
            elif node.type == "method_declaration":
                name = _t(node.child_by_field_name("name"))
                recv_var, recv_type = _receiver_type(node.child_by_field_name("receiver"))
                qual = f"{recv_type}.{name}" if recv_type else name
                self._symbol(r, "method" if recv_type else "function", name, qual, node, recv_type)
                self._walk_body(r, node.child_by_field_name("body"), qual, recv_var, router_vars)
            elif node.type == "type_declaration":
                for spec in (c for c in node.named_children if c.type == "type_spec"):
                    tname = _t(spec.child_by_field_name("name"))
                    tnode = spec.child_by_field_name("type")
                    kind = (
                        "interface"
                        if tnode is not None and tnode.type == "interface_type"
                        else "class"
                        if tnode is not None and tnode.type == "struct_type"
                        else "type"
                    )
                    bases: list[str] = []
                    if tnode is not None and tnode.type == "struct_type":
                        for fl in (c for c in tnode.named_children if c.type == "field_declaration_list"):
                            for fd in (c for c in fl.named_children if c.type == "field_declaration"):
                                if fd.child_by_field_name("name") is None:  # embedded type
                                    typ = fd.child_by_field_name("type")
                                    while typ is not None and typ.type == "pointer_type":
                                        typ = typ.named_children[0] if typ.named_children else None
                                    if typ is not None:
                                        bases.append(_chain(typ) or _t(typ))
                    sym = self._symbol(r, kind, tname, tname, spec, None)
                    sym.bases = [b for b in bases if b]
            elif node.type in ("var_declaration", "const_declaration"):
                self._walk_body(r, node, "<module>", None, router_vars)
        # route registration attribution
        for route in r.routes:
            fw = router_vars.get(route.receiver or "")
            if fw:
                route.framework, route.confidence = fw, "confirmed"
        return r

    @staticmethod
    def _symbol(r: FileAnalysis, kind: str, name: str, qual: str, node: Node, parent: str | None) -> SymbolInfo:
        first = _t(node).splitlines()[0] if node.text else ""
        sym = SymbolInfo(
            kind=kind,
            name=name,
            qualified_name=qual,
            start_line=node.start_point[0] + 1,
            end_line=node.end_point[0] + 1,
            exported=name[:1].isupper(),
            signature=first[:300],
            parent=parent,
        )
        r.symbols.append(sym)
        if sym.exported and parent is None:
            r.exports.append(name)
        return sym

    def _walk_body(self, r: FileAnalysis, body: Node | None, caller: str, recv_var: str | None, router_vars: dict[str, str]) -> None:
        if body is None:
            return
        stack = [body]
        while stack:
            n = stack.pop()
            if n.type == "short_var_declaration" or n.type == "var_spec" or n.type == "assignment_statement":
                left = n.child_by_field_name("left") or n.child_by_field_name("name")
                right = n.child_by_field_name("right") or n.child_by_field_name("value")
                if left is not None and right is not None:
                    lnames = [c for c in left.named_children if c.type == "identifier"] if left.type == "expression_list" else [left]
                    rvals = right.named_children if right.type == "expression_list" else [right]
                    for ln, rv in zip(lnames, rvals, strict=False):
                        if rv.type == "call_expression":
                            fn = _chain(rv.child_by_field_name("function"))
                            if fn in _ROUTER_CTORS:
                                router_vars[_t(ln)] = _ROUTER_CTORS[fn]
                        elif rv.type == "composite_literal" or (
                            rv.type == "unary_expression" and rv.named_children and rv.named_children[0].type == "composite_literal"
                        ):
                            lit = rv if rv.type == "composite_literal" else rv.named_children[0]
                            typ = _chain(lit.child_by_field_name("type"))
                            if typ and caller != "<module>":
                                r.local_types.setdefault(caller, {})[_t(ln)] = typ
            if n.type == "call_expression":
                fn_node = n.child_by_field_name("function")
                chain = _chain(fn_node)
                if chain is None:
                    r.skipped_dynamic_calls += 1
                elif chain not in _BUILTINS:
                    callee = chain
                    if recv_var and chain.startswith(recv_var + ".") and chain.count(".") == 1:
                        callee = "this." + chain.split(".", 1)[1]
                    r.calls.append(CallInfo(callee=callee, caller=caller, line=n.start_point[0] + 1, end_line=n.end_point[0] + 1))
                    self._maybe_route(r, n, chain)
            stack.extend(reversed(n.named_children))

    @staticmethod
    def _maybe_route(r: FileAnalysis, call: Node, chain: str) -> None:
        if "." not in chain:
            return
        receiver, method = chain.rsplit(".", 1)
        if method not in _HTTP_METHODS:
            return
        args = call.child_by_field_name("arguments")
        if args is None or not args.named_children:
            return
        route = _str(args.named_children[0])
        if route is None:
            return
        handler = _chain(args.named_children[-1]) if len(args.named_children) > 1 else None
        framework = "net/http" if receiver == "http" else "unknown"
        verb = method.upper() if method.upper() in {"GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"} else "ANY"
        r.routes.append(
            RouteInfo(
                framework=framework,
                method=verb,
                path=route,
                handler=handler,
                line=call.start_point[0] + 1,
                end_line=call.end_point[0] + 1,
                receiver=receiver,
                confidence="confirmed" if framework != "unknown" else "probable",
            )
        )
