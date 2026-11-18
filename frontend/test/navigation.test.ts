import { describe, expect, it } from "vitest";
import { actionsFor, questionFor } from "@/components/workspace/actions";
import { keyPath, symbolLabel, tabFromParams } from "@/components/workspace/nav";

const tab = (q: string) => tabFromParams(new URLSearchParams(q));

describe("Workspace deep links", () => {
  it("maps each view to one stable tab", () => {
    expect(tab("view=code&file=svc/auth.py&l=4-9")).toMatchObject({ id: "file:svc/auth.py", view: "code", title: "auth.py", params: { view: "code", file: "svc/auth.py", l: "4-9" } });
    expect(tab("view=symbol&key=sym:svc/auth.py%23login&section=impact")).toMatchObject({ id: "symbol:sym:svc/auth.py#login", view: "symbol", title: "login" });
    expect(tab("view=flow&entry=route:POST /login@svc/app.py:8")).toMatchObject({ view: "flow", title: "POST /login" });
    expect(tab("view=architecture&gview=files&prefix=svc")).toMatchObject({ id: "graph", params: { view: "architecture", gview: "files", prefix: "svc" } });
    expect(tab("")).toMatchObject({ id: "overview" });
  });

  it("keeps links from the previous release working", () => {
    expect(tab("view=architecture&gview=flows&entry=sym:a.py%23f")).toMatchObject({ view: "flow", params: { entry: "sym:a.py#f" } });
    expect(tab("file=svc/auth.py")).toMatchObject({ view: "code" });
    expect(tab("view=investigate&c=3")).toMatchObject({ id: "overview" });
  });

  it("does not carry assistant state in tab parameters", () => {
    expect(tab("view=code&file=a.py&c=12").params).not.toHaveProperty("c");
  });

  it("derives labels and paths from node keys", () => {
    expect(symbolLabel("sym:svc/models.py#Account.validate")).toBe("Account.validate");
    expect(symbolLabel("route:GET /items@main.go:15")).toBe("GET /items");
    expect(keyPath("sym:svc/models.py#Account")).toBe("svc/models.py");
    expect(keyPath("route:GET /x@a.go:1")).toBeNull();
  });
});

describe("Contextual investigation questions", () => {
  const fn = { kind: "symbol" as const, key: "sym:svc/auth.py#login", label: "login", path: "svc/auth.py", start: 4, end: 9, symbolKind: "function" };

  it("names the exact item and location", () => {
    expect(questionFor("explain", fn)).toBe("Explain what function login (svc/auth.py:4-9) does and how it fits into the repository.");
    expect(questionFor("trace", { kind: "route", key: "route:POST /login@a.py:1", label: "POST /login" })).toBe("What happens when a request reaches POST /login? Trace the execution in order.");
    expect(questionFor("architecture", null)).toMatch(/architecture of this repository/);
  });

  it("offers only actions that make sense for the item", () => {
    expect(actionsFor(fn)).toEqual(["explain", "usage", "trace", "dependencies", "impact"]);
    expect(actionsFor({ ...fn, symbolKind: "class" })).not.toContain("trace");
    expect(actionsFor({ kind: "route", key: "route:x", label: "x" })).toEqual(["trace", "impact"]);
    expect(actionsFor(null)).toEqual(["architecture"]);
  });
});
