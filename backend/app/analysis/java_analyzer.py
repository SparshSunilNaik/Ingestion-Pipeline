"""Java analyzer (Tree-sitter). Packages, imports, types, methods, constructors, calls, Spring routes.

Static types of local variables and parameters are taken from declarations, which lets
`obj.method()` resolve through the declared class (not the runtime class). Generics,
overload resolution by argument types, lambdas/method references, reflection and
annotation processors are not modelled.
"""

from __future__ import annotations

from functools import lru_cache

import tree_sitter_java as ts_java
from tree_sitter import Language, Node, Parser

from app.analysis.ir import CallInfo, EntryPointInfo, FileAnalysis, ImportBinding, ImportInfo, RouteInfo, SymbolInfo

MAX_SOURCE_BYTES = 2_000_000
_TYPE_DECLS = {
    "class_declaration": "class",
    "interface_declaration": "interface",
    "enum_declaration": "enum",
    "record_declaration": "class",
    "annotation_type_declaration": "interface",
}
_MAPPINGS = {"GetMapping": "GET", "PostMapping": "POST", "PutMapping": "PUT", "DeleteMapping": "DELETE", "PatchMapping": "PATCH", "RequestMapping": "ANY"}


@lru_cache(maxsize=1)
def _parser() -> Parser:
    return Parser(Language(ts_java.language()))


def _t(n: Node | None) -> str:
    return n.text.decode("utf-8", errors="replace") if n is not None and n.text is not None else ""


def _type_name(n: Node | None) -> str | None:
    if n is None:
        return None
    if n.type == "generic_type":
        return _type_name(n.named_children[0]) if n.named_children else None
    if n.type in ("type_identifier", "scoped_type_identifier", "identifier"):
        return _t(n)
    return None


def _annotations(node: Node) -> list[tuple[str, str | None]]:
    out: list[tuple[str, str | None]] = []
    for mods in (c for c in node.named_children if c.type == "modifiers"):
        for a in mods.named_children:
            if a.type in ("annotation", "marker_annotation"):
                name = _t(a.child_by_field_name("name")).rsplit(".", 1)[-1]
                value = None
                args = a.child_by_field_name("arguments")
                if args is not None:
                    for arg in args.named_children:
                        target = arg.child_by_field_name("value") if arg.type == "element_value_pair" else arg
                        if arg.type == "element_value_pair" and _t(arg.child_by_field_name("key")) not in ("value", "path"):
                            continue
                        if target is not None and target.type == "string_literal":
                            value = _t(target).strip('"')
                            break
                out.append((name, value))
    return out


def _modifiers(node: Node) -> str:
    return " ".join(_t(c) for c in node.named_children if c.type == "modifiers")


class JavaAnalyzer:
    languages = frozenset({"java"})

    def analyze(self, path: str, source: bytes) -> FileAnalysis:
        r = FileAnalysis(path=path, language="java")
        if len(source) > MAX_SOURCE_BYTES:
            r.errors.append("source_too_large")
            return r
        root = _parser().parse(source).root_node
        if root.has_error:
            r.errors.append("syntax_errors_present")
        for node in root.named_children:
            if node.type == "package_declaration":
                r.package = _t(node.named_children[0]) if node.named_children else None
            elif node.type == "import_declaration":
                text = _t(node)
                is_static = " static " in f" {text} "
                name_node = next((c for c in node.named_children if c.type in ("scoped_identifier", "identifier")), None)
                spec = _t(name_node)
                star = any(c.type == "asterisk" for c in node.named_children)
                if star:
                    r.imports.append(
                        ImportInfo(
                            spec=spec,
                            line=node.start_point[0] + 1,
                            end_line=node.end_point[0] + 1,
                            bindings=[ImportBinding(local="*", imported="*")],
                            kind="import",
                        )
                    )
                else:
                    local = spec.rsplit(".", 1)[-1]
                    r.imports.append(
                        ImportInfo(
                            spec=spec,
                            line=node.start_point[0] + 1,
                            end_line=node.end_point[0] + 1,
                            bindings=[ImportBinding(local=local, imported=local)],
                            kind="static" if is_static else "import",
                        )
                    )
            elif node.type in _TYPE_DECLS:
                self._type(r, node, None, "")
        return r

    def _type(self, r: FileAnalysis, node: Node, parent: str | None, prefix: str) -> None:
        name = _t(node.child_by_field_name("name"))
        qual = f"{parent}.{name}" if parent else name
        bases: list[str] = []
        sup = node.child_by_field_name("superclass")
        if sup is not None:
            bases += [b for b in (_type_name(c) for c in sup.named_children) if b]
        for field in ("interfaces", "extends_interfaces"):
            itf = node.child_by_field_name(field)
            if itf is None:
                itf = next((c for c in node.named_children if c.type in ("super_interfaces", "extends_interfaces")), None)
            if itf is not None:
                for tl in itf.named_children:
                    bases += [b for b in (_type_name(c) for c in (tl.named_children if tl.type == "type_list" else [tl])) if b]
                break
        mods = _modifiers(node)
        first = _t(node).splitlines()[0] if node.text else ""
        r.symbols.append(
            SymbolInfo(
                kind=_TYPE_DECLS[node.type],
                name=name,
                qualified_name=qual,
                start_line=node.start_point[0] + 1,
                end_line=node.end_point[0] + 1,
                exported="public" in mods,
                signature=first[:300],
                parent=parent,
                bases=list(dict.fromkeys(bases)),
            )
        )
        if parent is None and "public" in mods:
            r.exports.append(name)
        annotations = dict(_annotations(node))
        class_prefix = annotations.get("RequestMapping") or ""
        is_controller = "RestController" in annotations or "Controller" in annotations
        body = node.child_by_field_name("body")
        if body is None:
            return
        fields: dict[str, str] = {}
        for member in body.named_children:
            if member.type == "field_declaration":
                typ = _type_name(member.child_by_field_name("type"))
                for d in (c for c in member.named_children if c.type == "variable_declarator"):
                    if typ:
                        fields[_t(d.child_by_field_name("name"))] = typ
                    init = d.child_by_field_name("value")
                    if init is not None:
                        # Field initializers run on construction; attribute their calls to the class itself.
                        self._walk(r, init, qual, {})
        for member in body.named_children:
            if member.type in _TYPE_DECLS:
                self._type(r, member, qual, prefix)
            elif member.type in ("method_declaration", "constructor_declaration"):
                mname = _t(member.child_by_field_name("name"))
                mqual = f"{qual}.{mname}"
                mods_m = _modifiers(member)
                params = member.child_by_field_name("parameters")
                sig = f"{mods_m} {_t(member.child_by_field_name('type'))} {mname}{_t(params)}".strip()
                r.symbols.append(
                    SymbolInfo(
                        kind="method",
                        name=mname,
                        qualified_name=mqual,
                        start_line=member.start_point[0] + 1,
                        end_line=member.end_point[0] + 1,
                        exported="public" in mods_m,
                        signature=sig[:300],
                        parent=qual,
                        returns=_type_name(member.child_by_field_name("type")) if member.type == "method_declaration" else None,
                    )
                )
                if mname == "main" and "static" in mods_m and parent is None:
                    r.entry_points.append(
                        EntryPointInfo(kind="java_main", name=f"{qual}.main", line=member.start_point[0] + 1, end_line=member.end_point[0] + 1)
                    )
                locals_: dict[str, str] = {f"this.{k}": v for k, v in fields.items()}
                locals_.update(fields)
                if params is not None:
                    for p in params.named_children:
                        if p.type == "formal_parameter":
                            typ = _type_name(p.child_by_field_name("type"))
                            if typ:
                                locals_[_t(p.child_by_field_name("name"))] = typ
                self._walk(r, member.child_by_field_name("body"), mqual, locals_)
                if locals_:
                    r.local_types[mqual] = {k: v for k, v in locals_.items() if not k.startswith("this.")}
                for ann, value in _annotations(member):
                    if ann in _MAPPINGS and is_controller:
                        route = (class_prefix.rstrip("/") + "/" + (value or "").lstrip("/")).rstrip("/") or "/"
                        r.routes.append(
                            RouteInfo(
                                framework="Spring",
                                method=_MAPPINGS[ann],
                                path=route,
                                handler=mqual,
                                line=member.start_point[0] + 1,
                                end_line=member.end_point[0] + 1,
                                confidence="candidate",
                            )
                        )

    def _walk(self, r: FileAnalysis, body: Node | None, caller: str, locals_: dict[str, str]) -> None:
        if body is None:
            return
        stack = [body]
        while stack:
            n = stack.pop()
            if n.type == "local_variable_declaration":
                typ = _type_name(n.child_by_field_name("type"))
                for d in (c for c in n.named_children if c.type == "variable_declarator"):
                    value = d.child_by_field_name("value")
                    vtyp = typ
                    if (typ is None or typ == "var") and value is not None and value.type == "object_creation_expression":
                        vtyp = _type_name(value.child_by_field_name("type"))
                    if vtyp and vtyp != "var":
                        locals_[_t(d.child_by_field_name("name"))] = vtyp
            elif n.type == "method_invocation":
                name = _t(n.child_by_field_name("name"))
                obj = n.child_by_field_name("object")
                if obj is None or obj.type == "this":
                    callee = f"this.{name}"
                elif obj.type == "super":
                    callee = f"super.{name}"
                elif obj.type in ("identifier", "field_access", "scoped_identifier"):
                    target = _t(obj)
                    if target.startswith("this.") and target.count(".") == 1:
                        target = target[5:]  # this.field.m() -> field.m(), typed through the field declaration
                    callee = f"{target}.{name}"
                else:
                    callee = None
                    r.skipped_dynamic_calls += 1
                if callee:
                    r.calls.append(CallInfo(callee=callee, caller=caller, line=n.start_point[0] + 1, end_line=n.end_point[0] + 1))
            elif n.type == "object_creation_expression":
                typ = _type_name(n.child_by_field_name("type"))
                if typ:
                    r.calls.append(CallInfo(callee=typ, caller=caller, line=n.start_point[0] + 1, end_line=n.end_point[0] + 1))
            stack.extend(reversed(n.named_children))
