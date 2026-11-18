from app.analysis.docs import split_sections
from app.analysis.manifests import normalize_python_name, parse_manifest
from app.analysis.resolver import ModuleIndex

PATHS = {
    "backend/app/__init__.py",
    "backend/app/main.py",
    "backend/app/api/__init__.py",
    "backend/app/api/routes.py",
    "backend/app/services/inventory.py",
    "src/pkg/__init__.py",
    "src/pkg/core.py",
    "web/src/lib/api.ts",
    "web/src/lib/index.ts",
    "web/app/page.tsx",
    "web/util.js",
    "web/esm.ts",
}


def idx() -> ModuleIndex:
    i = ModuleIndex(PATHS, PATHS)
    i.load_ts_aliases({"web/tsconfig.json": '{ // c\n "compilerOptions": {"baseUrl": ".", "paths": {"@/*": ["./src/*"]},}}'})
    return i


def test_python_absolute_and_relative() -> None:
    i = idx()
    assert i.resolve_python("backend/app/main.py", "app.api.routes", 0).target_path == "backend/app/api/routes.py"
    assert i.resolve_python("backend/app/api/routes.py", "services.inventory", 2).target_path == "backend/app/services/inventory.py"
    assert i.resolve_python("backend/app/main.py", "app.api", 0, "routes").target_path == "backend/app/api/routes.py"
    assert i.resolve_python("x.py", "pkg.core", 0).target_path == "src/pkg/core.py"
    assert i.resolve_python("x.py", "os.path", 0).status == "stdlib"
    r = i.resolve_python("x.py", "requests.adapters", 0)
    assert (r.status, r.package) == ("external", "requests")
    assert i.resolve_python("backend/app/main.py", "missing", 1).status == "unresolved"
    assert i.resolve_python("a.py", "x", 5).status == "unresolved"
    assert i.python_module_name("backend/app/api/routes.py") == "app.api.routes"


def test_js_resolution() -> None:
    i = idx()
    assert i.resolve_js("web/app/page.tsx", "../src/lib/api").target_path == "web/src/lib/api.ts"
    assert i.resolve_js("web/app/page.tsx", "../src/lib").target_path == "web/src/lib/index.ts"
    assert i.resolve_js("web/app/page.tsx", "@/lib/api").target_path == "web/src/lib/api.ts"
    assert i.resolve_js("web/app/page.tsx", "../esm.js").target_path == "web/esm.ts"
    assert i.resolve_js("web/app/page.tsx", "./nope").status == "unresolved"
    assert i.resolve_js("web/a.ts", "../../../outside").status == "unresolved"
    assert (i.resolve_js("x.ts", "@scope/pkg/sub").package) == "@scope/pkg"
    assert i.resolve_js("x.ts", "react-dom/client").package == "react-dom"
    assert i.resolve_js("x.ts", "fs").status == "stdlib"
    assert i.resolve_js("x.ts", "node:fs").status == "stdlib"


def test_package_json() -> None:
    m = parse_manifest(
        "package.json",
        '{\n "name": "x",\n "scripts": {"dev": "next dev"},\n "dependencies": {\n  "react": "^19"\n },\n "devDependencies": {"jest": "1"},\n "bin": {"tool": "cli.js"}\n}',
    )
    assert m is not None
    deps = {(d.name, d.scope, d.line) for d in m.dependencies}
    assert ("react", "runtime", 5) in deps
    assert ("jest", "dev", 7) in deps
    assert m.scripts["dev"][0] == "next dev"
    assert m.entry_points[0][0] == "package_bin"


def test_pyproject_and_requirements() -> None:
    m = parse_manifest(
        "pyproject.toml",
        '[project]\nname="x"\nrequires-python=">=3.12"\ndependencies=["FastAPI[all]>=0.1; python_version>\'3\'", "pydantic"]\n[project.optional-dependencies]\ndev=["pytest"]\n[project.scripts]\ncli="x:main"\n[tool.poetry.dependencies]\npython="^3.12"\nrich="*"\n',
    )
    assert m is not None
    names = {(d.name, d.scope) for d in m.dependencies}
    assert {("FastAPI", "runtime"), ("pydantic", "runtime"), ("pytest", "optional"), ("rich", "runtime")} <= names
    assert not any(d.name == "python" for d in m.dependencies)
    assert m.metadata["requires-python"] == ">=3.12"
    assert m.entry_points[0][0] == "console_script"
    r = parse_manifest("requirements-dev.txt", "# c\nrequests==2.0  # pin\n-r base.txt\n-e .\ngit+https://x\nPyYAML>=6\n")
    assert r is not None
    assert [(d.name, d.scope, d.line) for d in r.dependencies] == [("requests", "dev", 2), ("PyYAML", "dev", 6)]
    bad = parse_manifest("pyproject.toml", "not = [valid")
    assert bad is not None and bad.errors
    assert parse_manifest("setup.py", "import os; os.system('x')") is None  # executable manifests are never evaluated
    assert normalize_python_name("Py_YAML.x") == "py-yaml-x"


def test_doc_sections_ignore_code_fences() -> None:
    text = "intro line\n# Title\nbody\n```\n# not a heading\n```\n## Install\npip install x\n"
    secs = split_sections("README.md", text)
    assert [(s.title, s.start_line, s.end_line) for s in secs] == [("(preamble)", 1, 1), ("Title", 2, 6), ("Install", 7, 8)]
    assert secs[2].topic() == "installation"
