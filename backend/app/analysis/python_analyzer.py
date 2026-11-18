"""Python analyzer based on the standard-library ``ast`` module (never executes code)."""

from __future__ import annotations

import ast
import builtins
import warnings

from app.analysis.ir import (
    CallInfo,
    EntryPointInfo,
    FileAnalysis,
    ImportBinding,
    ImportInfo,
    RouteInfo,
    SymbolInfo,
)

_HTTP_DECORATORS = {"get", "post", "put", "delete", "patch", "options", "head", "route", "api_route", "websocket"}
_ROUTER_CONSTRUCTORS = {"FastAPI": "FastAPI", "APIRouter": "FastAPI", "Flask": "Flask", "Blueprint": "Flask"}
_BUILTINS = set(dir(builtins))
MAX_SOURCE_BYTES = 2_000_000


def _dotted(node: ast.AST) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = _dotted(node.value)
        return f"{base}.{node.attr}" if base else None
    return None


def _str_const(node: ast.AST | None) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return None


class _Visitor(ast.NodeVisitor):
    def __init__(self, result: FileAnalysis) -> None:
        self.r = result
        self.scope: list[tuple[str, str]] = []  # (kind, name)

    # -- helpers -----------------------------------------------------------
    def _qual(self, name: str) -> str:
        return ".".join([s[1] for s in self.scope] + [name])

    def _current_callable(self) -> str:
        for i in range(len(self.scope) - 1, -1, -1):
            if self.scope[i][0] == "function":
                return ".".join(s[1] for s in self.scope[: i + 1])
        return "<module>"

    def _method_class(self) -> str | None:
        """Qualified name of the class whose method body we are directly in."""
        if len(self.scope) >= 2 and self.scope[-1][0] == "function" and self.scope[-2][0] == "class":
            return ".".join(s[1] for s in self.scope[:-1])
        return None

    def _record_self_attr(self, target: ast.expr, typ: str | None) -> None:
        """`self.x = Cls(...)` / `self.x = param` (annotated) / `self.x: T` types attribute x of the class."""
        cls = self._method_class()
        if not (cls and typ and isinstance(target, ast.Attribute) and isinstance(target.value, ast.Name) and target.value.id == "self"):
            return
        self.r.local_types.setdefault(f"{cls}#attrs", {}).setdefault(target.attr, typ)

    def _enclosing_class(self) -> str | None:
        if self.scope and self.scope[-1][0] == "class":
            return ".".join(s[1] for s in self.scope)
        return None

    # -- definitions -------------------------------------------------------
    def _visit_function(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        cls = self._enclosing_class()
        kind = "method" if cls else "function"
        qual = self._qual(node.name)
        try:
            args = ast.unparse(node.args)
        except Exception:  # pragma: no cover
            args = "..."
        prefix = "async def" if isinstance(node, ast.AsyncFunctionDef) else "def"
        self.r.symbols.append(
            SymbolInfo(
                kind=kind,
                name=node.name,
                qualified_name=qual,
                start_line=min([node.lineno] + [d.lineno for d in node.decorator_list]),
                end_line=node.end_lineno or node.lineno,
                exported=not node.name.startswith("_") and not self.scope,
                signature=f"{prefix} {node.name}({args})"[:500],
                docstring=(ast.get_docstring(node) or "")[:500] or None,
                parent=cls,
                returns=_dotted(node.returns) if node.returns is not None else None,
            )
        )
        for dec in node.decorator_list:
            self._maybe_route(dec, qual)
        # Declared parameter types (e.g. `account: Account`) type the parameter for method resolution.
        for a in [*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs]:
            ann = _dotted(a.annotation) if a.annotation is not None else None
            if ann and ann.rsplit(".", 1)[-1][:1].isupper() and a.arg not in ("self", "cls"):
                self.r.local_types.setdefault(qual, {})[a.arg] = ann
        for dec in node.decorator_list:
            self.visit(dec)  # decorators evaluate in the enclosing scope
        for default in [*node.args.defaults, *node.args.kw_defaults]:
            if default is not None:
                self.visit(default)
        self.scope.append(("function", node.name))
        for child in node.body:
            self.visit(child)
        self.scope.pop()

    visit_FunctionDef = _visit_function
    visit_AsyncFunctionDef = _visit_function

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        qual = self._qual(node.name)
        bases = [b for b in (_dotted(x) for x in node.bases) if b]
        self.r.symbols.append(
            SymbolInfo(
                kind="class",
                name=node.name,
                qualified_name=qual,
                start_line=min([node.lineno] + [d.lineno for d in node.decorator_list]),
                end_line=node.end_lineno or node.lineno,
                exported=not node.name.startswith("_") and not self.scope,
                signature=f"class {node.name}({', '.join(bases)})" if bases else f"class {node.name}",
                docstring=(ast.get_docstring(node) or "")[:500] or None,
                parent=self._enclosing_class(),
                bases=bases,
            )
        )
        for dec in node.decorator_list:
            self.visit(dec)
        self.scope.append(("class", node.name))
        for child in node.body:
            self.visit(child)
        self.scope.pop()

    # -- imports -----------------------------------------------------------
    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            local = alias.asname or alias.name.split(".")[0]
            self.r.imports.append(
                ImportInfo(
                    spec=alias.name,
                    line=node.lineno,
                    end_line=node.end_lineno or node.lineno,
                    bindings=[ImportBinding(local=local, imported=None)],
                    kind="import",
                )
            )

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        self.r.imports.append(
            ImportInfo(
                spec=node.module or "",
                line=node.lineno,
                end_line=node.end_lineno or node.lineno,
                level=node.level or 0,
                bindings=[ImportBinding(local=a.asname or a.name, imported=a.name) for a in node.names],
                kind="from",
            )
        )

    # -- calls / assignments -----------------------------------------------
    def visit_Call(self, node: ast.Call) -> None:
        callee = _dotted(node.func)
        if (
            callee is None
            and isinstance(node.func, ast.Attribute)
            and isinstance(node.func.value, ast.Call)
            and isinstance(node.func.value.func, ast.Name)
            and node.func.value.func.id == "super"
        ):
            callee = f"super.{node.func.attr}"
        if callee is None:
            self.r.skipped_dynamic_calls += 1
        elif callee in _BUILTINS:
            pass  # builtins are not repository references
        else:
            self.r.calls.append(CallInfo(callee=callee, caller=self._current_callable(), line=node.lineno, end_line=node.end_lineno or node.lineno))
            self._maybe_django_path(node, callee)
        self.generic_visit(node)

    def visit_Assign(self, node: ast.Assign) -> None:
        if self.scope and isinstance(node.value, ast.Call):
            ctor = _dotted(node.value.func)
            caller = self._current_callable()
            # `x = Cls(...)` types x as Cls; `x = factory(...)` types x through factory's return annotation
            # (resolved in the engine; unannotated factories leave x untyped).
            if ctor and caller != "<module>":
                for t in node.targets:
                    if isinstance(t, ast.Name):
                        self.r.local_types.setdefault(caller, {})[t.id] = ctor
        if self.scope:
            caller = self._current_callable()
            typ = None
            if isinstance(node.value, ast.Call):
                typ = _dotted(node.value.func)
            elif isinstance(node.value, ast.Name):
                typ = self.r.local_types.get(caller, {}).get(node.value.id)
            for t in node.targets:
                self._record_self_attr(t, typ)
        if not self.scope and isinstance(node.value, ast.Call):
            ctor = _dotted(node.value.func)
            if ctor:
                for t in node.targets:
                    if isinstance(t, ast.Name):
                        self.r.instantiations[t.id] = ctor
        if not self.scope:
            for t in node.targets:
                if isinstance(t, ast.Name) and t.id == "__all__" and isinstance(node.value, (ast.List, ast.Tuple)):
                    self.r.exports.extend(v for v in (_str_const(e) for e in node.value.elts) if v)
        self.generic_visit(node)

    def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
        if self.scope:
            self._record_self_attr(node.target, _dotted(node.annotation))
        self.generic_visit(node)

    def visit_If(self, node: ast.If) -> None:
        test = node.test
        if (
            not self.scope
            and isinstance(test, ast.Compare)
            and isinstance(test.left, ast.Name)
            and test.left.id == "__name__"
            and any(_str_const(c) == "__main__" for c in test.comparators)
        ):
            self.r.entry_points.append(EntryPointInfo(kind="python_main_guard", name="__main__", line=node.lineno, end_line=node.end_lineno or node.lineno))
        self.generic_visit(node)

    # -- frameworks --------------------------------------------------------
    def _maybe_route(self, dec: ast.expr, handler: str) -> None:
        if not isinstance(dec, ast.Call) or not isinstance(dec.func, ast.Attribute):
            return
        method = dec.func.attr
        if method not in _HTTP_DECORATORS:
            return
        receiver = _dotted(dec.func.value)
        path = _str_const(dec.args[0]) if dec.args else None
        if path is None:
            for kw in dec.keywords:
                if kw.arg in ("path", "rule"):
                    path = _str_const(kw.value)
        if path is None:
            return
        methods = [method.upper()]
        if method in ("route", "api_route"):
            methods = ["GET"]
            for kw in dec.keywords:
                if kw.arg == "methods" and isinstance(kw.value, (ast.List, ast.Tuple, ast.Set)):
                    vals = [_str_const(e) for e in kw.value.elts]
                    methods = [v.upper() for v in vals if v] or methods
        if method == "websocket":
            methods = ["WEBSOCKET"]
        ctor = self.r.instantiations.get(receiver or "", "")
        framework = _ROUTER_CONSTRUCTORS.get(ctor.split(".")[-1])
        for m in methods:
            self.r.routes.append(
                RouteInfo(
                    framework=framework or "unknown",
                    method=m,
                    path=path,
                    handler=handler,
                    line=dec.lineno,
                    end_line=dec.end_lineno or dec.lineno,
                    receiver=receiver,
                    confidence="confirmed" if framework else "probable",
                )
            )

    def _maybe_django_path(self, node: ast.Call, callee: str) -> None:
        if callee not in ("path", "re_path", "django.urls.path", "django.urls.re_path"):
            return
        if len(node.args) < 2:
            return
        route = _str_const(node.args[0])
        if route is None:
            return
        handler = _dotted(node.args[1])
        if handler is None and isinstance(node.args[1], ast.Call):
            handler = _dotted(node.args[1].func)  # e.g. View.as_view()
        self.r.routes.append(
            RouteInfo(
                framework="Django", method="ANY", path=route, handler=handler, line=node.lineno, end_line=node.end_lineno or node.lineno, confidence="probable"
            )
        )


class PythonAnalyzer:
    languages = frozenset({"python"})

    def analyze(self, path: str, source: bytes) -> FileAnalysis:
        result = FileAnalysis(path=path, language="python")
        if len(source) > MAX_SOURCE_BYTES:
            result.errors.append("source_too_large")
            return result
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                tree = ast.parse(source.decode("utf-8", errors="replace"), filename=path, type_comments=False)
        except (SyntaxError, ValueError, RecursionError, MemoryError) as exc:
            result.errors.append(f"parse_error: {type(exc).__name__}")
            return result
        visitor = _Visitor(result)
        try:
            visitor.visit(tree)
        except RecursionError:
            result.errors.append("recursion_limit")
        # Django routes only count when django.urls is imported in this file.
        if any(r.framework == "Django" for r in result.routes):
            if any(i.spec.startswith("django") for i in result.imports):
                for r in result.routes:
                    if r.framework == "Django":
                        r.confidence = "confirmed"
            else:
                result.routes = [r for r in result.routes if r.framework != "Django"]
        return result
