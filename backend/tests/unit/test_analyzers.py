from app.analysis.python_analyzer import PythonAnalyzer
from app.analysis.ts_analyzer import TypeScriptAnalyzer

PY = b'''
"""module doc"""
import os, a.b as c
from .util import helper as h
from fastapi import FastAPI, APIRouter
from flask import Flask

app = FastAPI()
router = APIRouter()
web = Flask(__name__)
__all__ = ["Svc", "read"]


class Svc(Base, mixins.M):
    """Service docs."""

    def run(self, x):
        self.go()
        h(x)
        os.path.join("a")
        print(x)
        get_obj().method()

    async def go(self):
        pass


@app.get("/items/{id}")
async def read(id: int):
    return Svc().run(id)


@router.post("/things")
def make():
    pass


@web.route("/legacy", methods=["GET", "POST"])
def legacy():
    pass


@unknown.get("/maybe")
def maybe():
    pass


if __name__ == "__main__":
    read(1)
'''


def test_python_symbols_and_routes() -> None:
    r = PythonAnalyzer().analyze("pkg/main.py", PY)
    assert not r.errors
    kinds = {(s.kind, s.qualified_name) for s in r.symbols}
    assert ("class", "Svc") in kinds
    assert ("method", "Svc.run") in kinds
    assert ("method", "Svc.go") in kinds
    assert ("function", "read") in kinds
    svc = next(s for s in r.symbols if s.name == "Svc")
    assert svc.bases == ["Base", "mixins.M"]
    assert svc.docstring == "Service docs."
    read = next(s for s in r.symbols if s.name == "read")
    assert read.start_line == 28  # includes the decorator line
    assert read.signature.startswith("async def read(")
    routes = {(x.framework, x.method, x.path, x.handler, x.confidence) for x in r.routes}
    assert ("FastAPI", "GET", "/items/{id}", "read", "confirmed") in routes
    assert ("FastAPI", "POST", "/things", "make", "confirmed") in routes
    assert ("Flask", "GET", "/legacy", "legacy", "confirmed") in routes
    assert ("Flask", "POST", "/legacy", "legacy", "confirmed") in routes
    assert ("unknown", "GET", "/maybe", "maybe", "probable") in routes
    assert r.exports == ["Svc", "read"]
    assert [e.kind for e in r.entry_points] == ["python_main_guard"]


def test_python_imports_and_calls() -> None:
    r = PythonAnalyzer().analyze("pkg/main.py", PY)
    specs = [(i.spec, i.level, i.kind) for i in r.imports]
    assert ("os", 0, "import") in specs
    assert ("a.b", 0, "import") in specs
    assert ("util", 1, "from") in specs
    calls = {(c.callee, c.caller) for c in r.calls}
    assert ("self.go", "Svc.run") in calls
    assert ("h", "Svc.run") in calls
    assert ("os.path.join", "Svc.run") in calls
    assert ("app.get", "<module>") in calls  # decorators run in the enclosing scope
    assert not any(c.callee == "print" for c in r.calls)  # builtins are not repository references
    assert r.skipped_dynamic_calls >= 1  # get_obj().method()


def test_python_syntax_error_is_reported_not_raised() -> None:
    r = PythonAnalyzer().analyze("bad.py", b"def broken(:\n")
    assert r.errors and r.errors[0].startswith("parse_error")
    assert r.symbols == []


def test_python_django_routes_require_django_import() -> None:
    src = b"from django.urls import path\nfrom . import views\nurlpatterns = [path('home/', views.home)]\n"
    r = PythonAnalyzer().analyze("site/urls.py", src)
    assert [(x.framework, x.path, x.handler, x.confidence) for x in r.routes] == [("Django", "home/", "views.home", "confirmed")]
    r2 = PythonAnalyzer().analyze("other.py", b"urlpatterns = [path('home/', views.home)]\n")
    assert r2.routes == []


TS = b"""
import React, { useState as us } from "react";
import * as path from "node:path";
import { helper } from "./lib/util";
export { thing } from "./thing";
const express = require("express");
const app = express();
export default function Page() { const [a] = us(0); helper(a); return null }
export const handler = async (req) => { return helper(req) };
export class Foo extends Bar { run() { this.go(); } go() {} }
app.get("/hello", handler);
export interface I { x: number }
export type T = string;
export enum E { A }
export async function GET() { return 1 }
console.log("x");
const lazy = import("./lazy");
module.exports.legacy = 1;
"""


def test_typescript_extraction() -> None:
    r = TypeScriptAnalyzer().analyze("app/api/hello/route.ts", TS)
    kinds = {(s.kind, s.qualified_name) for s in r.symbols}
    for expected in [
        ("function", "Page"),
        ("function", "handler"),
        ("class", "Foo"),
        ("method", "Foo.run"),
        ("method", "Foo.go"),
        ("interface", "I"),
        ("type", "T"),
        ("enum", "E"),
        ("function", "GET"),
    ]:
        assert expected in kinds
    assert next(s for s in r.symbols if s.name == "Foo").bases == ["Bar"]
    specs = {(i.spec, i.kind) for i in r.imports}
    assert {("react", "esm"), ("node:path", "esm"), ("./lib/util", "esm"), ("./thing", "reexport"), ("express", "require"), ("./lazy", "dynamic")} <= specs
    react = next(i for i in r.imports if i.spec == "react")
    assert {(b.local, b.imported) for b in react.bindings} == {("React", "default"), ("us", "useState")}
    calls = {(c.callee, c.caller) for c in r.calls}
    assert ("us", "Page") in calls
    assert ("helper", "handler") in calls
    assert ("this.go", "Foo.run") in calls
    assert not any(c.callee.startswith("console.") for c in r.calls)
    routes = {(x.framework, x.method, x.path, x.confidence) for x in r.routes}
    assert ("Express", "GET", "/hello", "confirmed") in routes
    assert ("Next.js", "GET", "/api/hello", "candidate") in routes
    assert {"Page", "default", "handler", "Foo", "GET", "thing", "legacy"} <= set(r.exports)


def test_tsx_and_jsx_parse() -> None:
    r = TypeScriptAnalyzer().analyze("a/Comp.tsx", b"export const C = () => <div onClick={() => go()}>hi</div>;\n")
    assert not r.errors
    assert ("go", "C") in {(c.callee, c.caller) for c in r.calls}
    r2 = TypeScriptAnalyzer().analyze("a/comp.jsx", b"export function C() { return <b>{x()}</b> }\n")
    assert ("x", "C") in {(c.callee, c.caller) for c in r2.calls}


def test_ts_syntax_errors_flagged() -> None:
    r = TypeScriptAnalyzer().analyze("x.ts", b"function ( {{{")
    assert "syntax_errors_present" in r.errors
