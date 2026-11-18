from app.analysis.go_analyzer import GoAnalyzer
from app.analysis.java_analyzer import JavaAnalyzer
from app.analysis.manifests import parse_manifest
from app.analysis.resolver import ModuleIndex

GO = b"""package main
import (
  "fmt"
  st "example.com/app/store"
  "github.com/gin-gonic/gin"
)
type Base struct{}
func (b *Base) Hello() string { return "x" }
type Server struct { Base; db *st.DB }
type Runner interface { Run() }
func (s *Server) Run() { s.Hello(); st.Open(); helper() }
func helper() { fmt.Println(len("x")) }
func main() {
  s := &Server{}
  s.Run()
  r := gin.Default()
  r.GET("/ping", helper)
}
"""


def test_go_analyzer() -> None:
    r = GoAnalyzer().analyze("cmd/main.go", GO)
    assert r.package == "main" and not r.errors
    kinds = {(s.kind, s.qualified_name, s.parent) for s in r.symbols}
    assert ("class", "Server", None) in kinds and ("method", "Server.Run", "Server") in kinds and ("interface", "Runner", None) in kinds
    assert next(s for s in r.symbols if s.name == "Server").bases == ["Base"]
    assert [(i.spec, i.bindings[0].local) for i in r.imports] == [("fmt", "fmt"), ("example.com/app/store", "st"), ("github.com/gin-gonic/gin", "gin")]
    calls = {(c.callee, c.caller) for c in r.calls}
    assert ("this.Hello", "Server.Run") in calls and ("st.Open", "Server.Run") in calls and ("helper", "Server.Run") in calls
    assert not any(c.callee == "len" for c in r.calls)  # builtins are not references
    assert r.local_types["main"]["s"] == "Server"
    assert [(x.framework, x.method, x.path, x.handler) for x in r.routes] == [("Gin", "GET", "/ping", "helper")]
    assert r.entry_points[0].kind == "go_main"
    assert {"Server", "Base", "Runner"} <= set(r.exports) and "helper" not in r.exports


JAVA = b"""package com.acme.web;
import com.acme.svc.UserService;
import org.springframework.web.bind.annotation.*;
@RestController
@RequestMapping("/users")
public class UserController extends BaseController implements Api {
  private final UserService service;
  public UserController(UserService s) { this.service = s; }
  @GetMapping("/{id}")
  public User get(String id) { audit(); return this.service.find(id); }
  public static void main(String[] args) { new UserController(null); }
}
"""


def test_java_analyzer() -> None:
    r = JavaAnalyzer().analyze("src/com/acme/web/UserController.java", JAVA)
    assert r.package == "com.acme.web" and not r.errors
    ctl = next(s for s in r.symbols if s.name == "UserController" and s.kind == "class")
    assert ctl.bases == ["BaseController", "Api"]
    calls = {(c.callee, c.caller) for c in r.calls}
    assert ("this.audit", "UserController.get") in calls
    assert ("service.find", "UserController.get") in calls  # this.field.m() normalised to field.m()
    assert ("UserController", "UserController.main") in calls  # constructor call
    assert r.local_types["UserController.get"]["service"] == "UserService"
    assert [(x.framework, x.method, x.path, x.handler) for x in r.routes] == [("Spring", "GET", "/users/{id}", "UserController.get")]
    assert [e.kind for e in r.entry_points] == ["java_main"]
    stars = [i for i in r.imports if i.bindings[0].local == "*"]
    assert stars and stars[0].spec == "org.springframework.web.bind.annotation"


def test_go_and_java_resolution() -> None:
    paths = {"go.mod", "store/store.go", "store/store_test.go", "cmd/main.go", "src/a/B.java", "src/a/C.java"}
    idx = ModuleIndex(paths, paths)
    idx.load_go_modules({"go.mod": "module example.com/app\n"})
    r = idx.resolve_go("example.com/app/store")
    assert r.status == "resolved" and r.candidates == ["store/store.go"]  # _test files excluded
    assert idx.resolve_go("fmt").status == "stdlib"
    assert idx.resolve_go("github.com/gin-gonic/gin/binding").package == "github.com/gin-gonic/gin"
    idx.register_java("src/a/B.java", "a", ["B"])
    idx.register_java("src/a/C.java", "a", ["C"])
    assert idx.resolve_java("a.B").target_path == "src/a/B.java"
    assert idx.resolve_java("a.B.helper").target_path == "src/a/B.java"  # static member import
    assert sorted(idx.resolve_java("a", star=True).candidates or []) == ["src/a/B.java", "src/a/C.java"]
    assert idx.resolve_java("java.util.List").status == "stdlib"
    assert idx.resolve_java("a.Missing").status == "unresolved"
    assert idx.resolve_java("org.x.Y").package == "org.x"


def test_go_mod_pom_gradle() -> None:
    g = parse_manifest(
        "go.mod",
        "module example.com/app\n\ngo 1.22\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.0\n\tgolang.org/x/sys v0.1.0 // indirect\n)\nrequire github.com/a/b v1.0.0\n",
    )
    assert g is not None and g.metadata["module"] == "example.com/app"
    assert [(d.name, d.scope, d.line) for d in g.dependencies] == [
        ("github.com/gin-gonic/gin", "runtime", 6),
        ("golang.org/x/sys", "indirect", 7),
        ("github.com/a/b", "runtime", 9),
    ]
    pom = parse_manifest(
        "pom.xml",
        '<!DOCTYPE x [<!ENTITY a "aaaa">]><project><dependencies>\n<dependency><groupId>g</groupId><artifactId>a</artifactId><scope>test</scope></dependency>\n</dependencies></project>',
    )
    assert pom is not None and [(d.name, d.scope) for d in pom.dependencies] == [("g:a", "dev")]
    gr = parse_manifest("build.gradle.kts", 'dependencies {\n  implementation("com.google.guava:guava:33.0")\n  api "x.y:z"\n}\n')
    assert gr is not None and [(d.name, d.specifier) for d in gr.dependencies] == [("com.google.guava:guava", "33.0"), ("x.y:z", None)]
