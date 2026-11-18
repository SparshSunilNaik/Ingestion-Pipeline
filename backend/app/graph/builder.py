"""Repository graph construction (NetworkX) and graph analytics.

Node keys:  file:<path> | sym:<path>#<qualified name> | pkg:<ecosystem>:<name> | route:<METHOD path>@<file>:<line> | unresolved:<kind>:<name>
Edge kinds: contains, imports, calls, inherits, declares_route, handled_by, declares_dependency
Resolution: resolved | ambiguous | external | unresolved
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from typing import Any

import networkx as nx


@dataclass
class EdgeAgg:
    resolution: str
    evidence_id: str | None
    count: int = 1
    attrs: dict[str, Any] = field(default_factory=dict)


class GraphBuilder:
    def __init__(self) -> None:
        self.nodes: dict[str, dict[str, Any]] = {}
        self.edges: dict[tuple[str, str, str], EdgeAgg] = {}

    def node(self, key: str, kind: str, label: str, path: str | None = None, start: int | None = None, end: int | None = None, **attrs: Any) -> str:
        if key not in self.nodes:
            self.nodes[key] = {"key": key, "kind": kind, "label": label[:600], "path": path, "start_line": start, "end_line": end, "attrs": attrs}
        return key

    def edge(self, src: str, dst: str, kind: str, resolution: str, evidence_id: str | None, **attrs: Any) -> None:
        k = (src, dst, kind)
        if k in self.edges:
            self.edges[k].count += 1
        else:
            self.edges[k] = EdgeAgg(resolution, evidence_id, 1, attrs)

    def to_networkx(self) -> nx.MultiDiGraph:
        g: nx.MultiDiGraph = nx.MultiDiGraph()
        for key, n in self.nodes.items():
            g.add_node(key, **{k: v for k, v in n.items() if k != "key"})
        for (s, d, kind), e in self.edges.items():
            g.add_edge(s, d, key=kind, kind=kind, resolution=e.resolution, count=e.count)
        return g


def file_key(path: str) -> str:
    return f"file:{path}"


def sym_key(path: str, qual: str) -> str:
    return f"sym:{path}#{qual}"


def pkg_key(eco: str, name: str) -> str:
    return f"pkg:{eco}:{name}"


def central_files(g: GraphBuilder, limit: int = 15) -> list[dict[str, Any]]:
    indeg: Counter[str] = Counter()
    for (src, dst, kind), e in g.edges.items():
        if kind == "imports" and e.resolution == "resolved" and dst.startswith("file:") and src != dst:
            indeg[dst] += 1
    return [{"key": k, "path": k[5:], "imported_by": c} for k, c in indeg.most_common(limit)]


def most_referenced(g: GraphBuilder, limit: int = 20) -> list[dict[str, Any]]:
    refs: Counter[str] = Counter()
    for (_src, dst, kind), e in g.edges.items():
        if kind in ("calls", "inherits", "handled_by") and e.resolution == "resolved" and dst.startswith("sym:"):
            refs[dst] += e.count
    out = []
    for k, c in refs.most_common(limit):
        n = g.nodes.get(k, {})
        out.append({"key": k, "label": n.get("label"), "kind": n.get("kind"), "path": n.get("path"), "references": c})
    return out
