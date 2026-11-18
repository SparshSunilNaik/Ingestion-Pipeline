"""Read-side graph intelligence over a persisted snapshot: execution flows, usage, impact.

All results are derived from persisted, evidence-backed edges. Ordering of flow steps is
*source order of call sites inside a function*, which is not a runtime ordering: branches,
loops and early returns are not modelled, so every downstream step is a *possible* step.
"""

from __future__ import annotations

import threading
from collections import defaultdict, deque
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database.models import Evidence, FileRecord, Finding, GraphEdge, GraphNode, Snapshot

FLOW_EDGE_KINDS = ("calls", "handled_by")
DEPENDENCY_EDGE_KINDS = ("imports", "calls", "inherits", "handled_by")


@dataclass
class Edge:
    source: str
    target: str
    kind: str
    resolution: str
    evidence_id: str | None
    attrs: dict[str, Any]


@dataclass
class GraphIndex:
    snapshot_id: int
    nodes: dict[str, GraphNode]
    out: dict[str, list[Edge]] = field(default_factory=lambda: defaultdict(list))
    inc: dict[str, list[Edge]] = field(default_factory=lambda: defaultdict(list))
    test_files: set[str] = field(default_factory=set)

    def node_info(self, key: str) -> dict[str, Any]:
        n = self.nodes.get(key)
        if n is None:
            kind = key.split(":", 1)[0]
            return {"key": key, "kind": kind, "label": key.split(":", 2)[-1], "path": None, "start_line": None, "end_line": None}
        return {"key": n.key, "kind": n.kind, "label": n.label, "path": n.path, "start_line": n.start_line, "end_line": n.end_line}

    def file_of(self, key: str) -> str | None:
        n = self.nodes.get(key)
        return n.path if n is not None else None


_cache: dict[tuple[str, int, str, str], GraphIndex] = {}
_lock = threading.Lock()


def load_index(session: Session, snapshot: Snapshot) -> GraphIndex:
    """Ready snapshots are immutable, so their index is cached per process."""
    cacheable = snapshot.status == "ready"
    bind = session.get_bind()
    db_url = str(bind.engine.url)
    key = (db_url, snapshot.id, snapshot.commit_sha, snapshot.analyzer_version)
    if cacheable:
        with _lock:
            if key in _cache:
                return _cache[key]
    nodes = {n.key: n for n in session.scalars(select(GraphNode).where(GraphNode.snapshot_id == snapshot.id))}
    idx = GraphIndex(snapshot_id=snapshot.id, nodes=nodes)
    for e in session.scalars(select(GraphEdge).where(GraphEdge.snapshot_id == snapshot.id)):
        edge = Edge(e.source_key, e.target_key, e.kind, e.resolution, e.evidence_id, e.attrs or {})
        idx.out[e.source_key].append(edge)
        idx.inc[e.target_key].append(edge)
    idx.test_files = set(session.scalars(select(FileRecord.path).where(FileRecord.snapshot_id == snapshot.id, FileRecord.category == "test")))
    for lst in idx.out.values():
        lst.sort(key=lambda e: (int(e.attrs.get("line") or 0), e.target))
    if cacheable:
        with _lock:
            if len(_cache) > 16:
                _cache.clear()
            _cache[key] = idx
    return idx


def clear_cache() -> None:
    with _lock:
        _cache.clear()


# ---------------------------------------------------------------------------- entry points
def entry_points(session: Session, snapshot: Snapshot, idx: GraphIndex) -> list[dict[str, Any]]:
    """Traceable starting points: route handlers, main functions/guards, CLI scripts."""
    out: list[dict[str, Any]] = []
    for f in session.scalars(select(Finding).where(Finding.snapshot_id == snapshot.id, Finding.kind.in_(["route", "entry_point"]))):
        d = f.detail or {}
        if f.kind == "route":
            rkey = d.get("route_key")
            handler = next((e.target for e in idx.out.get(rkey or "", []) if e.kind == "handled_by"), None)
            out.append(
                {
                    "kind": "route",
                    "label": f.name,
                    "framework": d.get("framework"),
                    "start_key": rkey,
                    "handler_key": handler,
                    "evidence_id": f.evidence_id,
                    "traceable": bool(rkey and rkey in idx.nodes),
                }
            )
        elif d.get("type") in ("python_main_guard", "go_main", "java_main"):
            key = d.get("node_key") or f"file:{d.get('path')}"
            out.append(
                {
                    "kind": d.get("type"),
                    "label": f.name,
                    "start_key": key,
                    "evidence_id": f.evidence_id,
                    "traceable": key in idx.nodes,
                    "line_range": [d.get("line"), d.get("end_line") or d.get("line")],
                }
            )
        elif d.get("type") == "console_script":
            # "name = module.path:function"
            target = str(f.name).split("=", 1)[-1].strip()
            module, _, func = target.partition(":")
            key = next((k for k, n in idx.nodes.items() if n.kind == "function" and n.label == func and n.path and module.replace(".", "/") in n.path), None)
            out.append({"kind": "console_script", "label": f.name, "start_key": key, "evidence_id": f.evidence_id, "traceable": key is not None})
    return out


# ---------------------------------------------------------------------------- flows
def trace_flow(idx: GraphIndex, start_key: str, max_depth: int = 6, max_steps: int = 120, line_range: list[int | None] | None = None) -> dict[str, Any]:
    """Bounded depth-first expansion of call edges from `start_key`, in call-site source order."""
    if start_key not in idx.nodes:
        return {"start": idx.node_info(start_key), "steps": [], "truncated": False, "error": "unknown start node"}
    steps: list[dict[str, Any]] = []
    truncated = False
    stats = {"resolved": 0, "ambiguous": 0, "unresolved": 0, "external": 0, "cycles": 0}

    def expand(key: str, depth: int, path: tuple[str, ...], parent: int | None) -> None:
        nonlocal truncated
        for e in idx.out.get(key, []):
            if e.kind not in FLOW_EDGE_KINDS:
                continue
            if key.startswith("file:") and line_range and line_range[0]:
                line = int(e.attrs.get("line") or 0)
                if not (line_range[0] <= line <= (line_range[1] or line_range[0])):  # type: ignore[operator]
                    continue  # only module-level calls inside the main guard
            if len(steps) >= max_steps:
                truncated = True
                return
            cycle = e.target in path
            stats[e.resolution] = stats.get(e.resolution, 0) + 1
            if cycle:
                stats["cycles"] += 1
            step = {
                "index": len(steps),
                "parent": parent,
                "depth": depth,
                "from": key,
                "to": idx.node_info(e.target),
                "edge_kind": e.kind,
                "resolution": e.resolution,
                "via": e.attrs.get("via"),
                "callee_text": e.attrs.get("callee"),
                "call_line": e.attrs.get("line"),
                "evidence_id": e.evidence_id,
                "cycle": cycle,
                "certainty": "possible" if depth > 0 or e.resolution != "resolved" else "direct",
                "leaf_reason": None,
            }
            steps.append(step)
            if cycle:
                step["leaf_reason"] = "cycle"
            elif e.resolution in ("unresolved", "external"):
                step["leaf_reason"] = e.resolution
            elif depth + 1 >= max_depth:
                step["leaf_reason"] = "depth_limit"
                truncated = True
            elif e.target.startswith(("sym:", "file:")):
                expand(e.target, depth + 1, (*path, e.target), len(steps) - 1)

    expand(start_key, 0, (start_key,), None)
    return {
        "start": idx.node_info(start_key),
        "steps": steps,
        "truncated": truncated,
        "stats": stats,
        "limits": {"max_depth": max_depth, "max_steps": max_steps},
        "semantics": "Steps follow statically resolved call sites in source order within each function. They are possible "
        "paths, not observed runtime order; conditionals, loops, exceptions and dynamic dispatch are not evaluated.",
    }


# ---------------------------------------------------------------------------- usage
def _bfs(idx: GraphIndex, seeds: list[str], depth: int, kinds: tuple[str, ...], reverse: bool, limit: int = 400) -> list[dict[str, Any]]:
    seen = dict.fromkeys(seeds, 0)
    queue = deque((s, 0) for s in seeds)
    out: list[dict[str, Any]] = []
    while queue and len(out) < limit:
        cur, d = queue.popleft()
        if d >= depth:
            continue
        edges = idx.inc.get(cur, []) if reverse else idx.out.get(cur, [])
        for e in edges:
            if e.kind not in kinds or e.resolution not in ("resolved", "ambiguous"):
                continue
            nxt = e.source if reverse else e.target
            if nxt in seen:
                continue
            seen[nxt] = d + 1
            out.append({**idx.node_info(nxt), "depth": d + 1, "via": e.kind, "resolution": e.resolution, "evidence_id": e.evidence_id, "through": cur})
            queue.append((nxt, d + 1))
    return out


def _members(idx: GraphIndex, key: str) -> list[str]:
    out, stack = [], [key]
    while stack:
        k = stack.pop()
        for e in idx.out.get(k, []):
            if e.kind == "contains":
                out.append(e.target)
                stack.append(e.target)
    return out


def usage(session: Session, idx: GraphIndex, key: str, depth: int = 3) -> dict[str, Any]:
    if key not in idx.nodes:
        return {"error": "unknown node"}
    node = idx.nodes[key]
    definition = {**idx.node_info(key), "evidence_id": None}
    contains = next((e for e in idx.inc.get(key, []) if e.kind == "contains"), None)
    if contains is not None:
        definition["evidence_id"] = contains.evidence_id
    direct = []
    for e in idx.inc.get(key, []):
        if e.kind in ("calls", "inherits", "handled_by"):
            direct.append(
                {
                    **idx.node_info(e.source),
                    "relation": e.kind,
                    "resolution": e.resolution,
                    "via": e.attrs.get("via"),
                    "evidence_id": e.evidence_id,
                    "call_line": e.attrs.get("line"),
                }
            )
    defining_file = node.path
    importers = []
    if defining_file:
        for e in idx.inc.get(f"file:{defining_file}", []):
            if e.kind == "imports":
                importers.append({**idx.node_info(e.source), "resolution": e.resolution, "evidence_id": e.evidence_id})
    callees = [
        {
            **idx.node_info(e.target),
            "relation": e.kind,
            "resolution": e.resolution,
            "via": e.attrs.get("via"),
            "evidence_id": e.evidence_id,
            "call_line": e.attrs.get("line"),
        }
        for e in idx.out.get(key, [])
        if e.kind in ("calls", "inherits")
    ]
    seeds = [key, *_members(idx, key)]
    upstream = _bfs(idx, seeds, depth, ("calls", "inherits", "handled_by"), reverse=True)
    downstream = _bfs(idx, seeds, depth, ("calls", "inherits"), reverse=False)
    routes = [u for u in upstream if u["kind"] == "route"]
    # Possible dynamic references: unresolved member calls with the same name (not proven to target this symbol).
    name = node.label.rsplit(".", 1)[-1]
    possible = []
    unresolved_key = f"unresolved:member:{name}"
    for e in idx.inc.get(unresolved_key, []):
        possible.append({**idx.node_info(e.source), "evidence_id": e.evidence_id, "callee_text": e.attrs.get("callee")})
    return {
        "definition": definition,
        "direct_references": direct,
        "importing_files": importers,
        "direct_callees": callees,
        "related_routes": routes,
        "upstream_transitive": [u for u in upstream if u["depth"] > 1],
        "downstream_transitive": [d for d in downstream if d["depth"] > 1],
        "possible_dynamic_references": possible[:50],
        "notes": [
            "direct_* lists are single evidence-backed edges; *_transitive lists are graph reachability (depth > 1).",
            "possible_dynamic_references are unresolved calls with the same member name; they are NOT proven to target this symbol.",
        ],
    }


# ---------------------------------------------------------------------------- impact
def impact(idx: GraphIndex, key: str, depth: int = 4) -> dict[str, Any]:
    if key not in idx.nodes:
        return {"error": "unknown node"}
    seeds = [key, *_members(idx, key)]
    reached = _bfs(idx, seeds, depth, DEPENDENCY_EDGE_KINDS, reverse=True, limit=500)
    direct = [r for r in reached if r["depth"] == 1]
    transitive = [r for r in reached if r["depth"] > 1]
    routes = [r for r in reached if r["kind"] == "route"]
    tests = sorted({r["path"] for r in reached if r.get("path") in idx.test_files})
    names = {idx.nodes[s].label.rsplit(".", 1)[-1] for s in seeds if s in idx.nodes and idx.nodes[s].kind != "file"}
    unresolved_refs = []
    for nm in names:
        for e in idx.inc.get(f"unresolved:member:{nm}", []) + idx.inc.get(f"unresolved:name:{nm}", []):
            unresolved_refs.append({**idx.node_info(e.source), "name": nm, "evidence_id": e.evidence_id})
    return {
        "key": key,
        "direct_dependents": direct,
        "transitive_dependents": transitive,
        "potentially_affected_routes": routes,
        "related_tests": tests,
        "unresolved_references": unresolved_refs[:50],
        "truncated": len(reached) >= 500,
        "limitations": [
            "Dependents are found by static reachability over resolved/ambiguous imports, calls, inheritance and route handlers.",
            "Reachability means POTENTIALLY affected, not guaranteed breakage; behaviour-preserving changes affect nothing.",
            "Dynamic dispatch, reflection, configuration, string-based routing and code outside the analysed coverage are not included.",
            "unresolved_references are call sites whose target could not be resolved but share a name with the changed symbol.",
        ],
    }


def evidence_location(session: Session, evidence_id: str | None) -> dict[str, Any] | None:
    if not evidence_id:
        return None
    ev = session.get(Evidence, evidence_id)
    return None if ev is None else {"path": ev.path, "start_line": ev.start_line, "end_line": ev.end_line}
