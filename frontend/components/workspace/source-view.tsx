"use client";

import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { useEffect, useMemo, useRef } from "react";
import type { Source } from "@/lib/api";
import { cn } from "@/components/ui";

const LANGS = { bash, css, dockerfile, go, ini, java, javascript, json, markdown, python, sql, typescript, xml, yaml };
for (const [name, def] of Object.entries(LANGS)) if (!hljs.getLanguage(name)) hljs.registerLanguage(name, def);

const MAP: Record<string, string> = {
  python: "python", typescript: "typescript", javascript: "javascript", go: "go", java: "java", json: "json", yaml: "yaml",
  xml: "xml", html: "xml", markdown: "markdown", shell: "bash", css: "css", scss: "css", toml: "ini", ini: "ini", sql: "sql", dockerfile: "dockerfile",
};
const MAX_HIGHLIGHT_CHARS = 400_000;

/** Split highlight.js HTML into per-line HTML, closing and reopening spans that cross line breaks. */
export function splitHighlighted(html: string): string[] {
  const out: string[] = [];
  const stack: string[] = [];
  let line = "";
  const re = /(<span[^>]*>)|(<\/span>)|(\n)|([^<\n]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[1]) {
      stack.push(m[1]);
      line += m[1];
    } else if (m[2]) {
      stack.pop();
      line += m[2];
    } else if (m[3]) {
      line += "</span>".repeat(stack.length);
      out.push(line);
      line = stack.join("");
    } else {
      line += m[4];
    }
  }
  out.push(line + "</span>".repeat(stack.length));
  return out;
}

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function SourceView({ source, highlight, onLineClick, onTopLine, markers, findLines, currentFind, embedded }: {
  source: Source;
  highlight?: [number, number] | null;
  onLineClick?: (line: number) => void;
  /** A short, non-interactive preview inside another control (no own focus stop). */
  embedded?: boolean;
  /** Reports the first visible line while scrolling (used for the sticky symbol context). */
  onTopLine?: (line: number) => void;
  markers?: Map<number, string>;
  /** Lines containing the current find-in-file query. */
  findLines?: Set<number>;
  /** The match the user navigated to; scrolled into view. */
  currentFind?: number | null;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => {
    const text = source.lines.join("\n");
    const lang = MAP[source.language ?? ""] ?? (source.path.toLowerCase().endsWith("dockerfile") ? "dockerfile" : undefined);
    if (lang && text.length <= MAX_HIGHLIGHT_CHARS) {
      try {
        // highlight.js escapes the source text; the result is safe to inject.
        return splitHighlighted(hljs.highlight(text, { language: lang, ignoreIllegals: true }).value);
      } catch {
        /* fall back to plain text */
      }
    }
    return source.lines.map(escapeHtml);
  }, [source]);

  useEffect(() => {
    if (!highlight || !scrollRef.current) return;
    const el = scrollRef.current.querySelector<HTMLElement>(`[data-line="${highlight[0]}"]`);
    if (el) scrollRef.current.scrollTop = Math.max(0, el.offsetTop - scrollRef.current.clientHeight / 3);
  }, [highlight, source]);

  useEffect(() => {
    if (!currentFind || !scrollRef.current) return;
    const el = scrollRef.current.querySelector<HTMLElement>(`[data-line="${currentFind}"]`);
    if (el) scrollRef.current.scrollTop = Math.max(0, el.offsetTop - scrollRef.current.clientHeight / 3);
  }, [currentFind]);

  const [lo, hi] = highlight ?? [0, -1];
  return (
    <div
      ref={scrollRef}
      className="relative h-full overflow-auto bg-code focus-visible:outline-offset-[-2px]"
      data-testid="source-view"
      // Keyboard users scroll the code with the arrow keys once it has focus.
      tabIndex={embedded ? undefined : 0}
      role={embedded ? undefined : "region"}
      aria-label={embedded ? undefined : `Source of ${source.path}, lines ${source.start_line} to ${source.start_line + source.lines.length - 1}`}
      onScroll={
        onTopLine
          ? (e) => {
              const el = e.currentTarget;
              requestAnimationFrame(() => onTopLine(source.start_line + Math.floor(el.scrollTop / 20)));
            }
          : undefined
      }
    >
      <table className="w-full border-collapse font-mono text-[12.5px] leading-[20px]">
        <tbody>
          {lines.map((html, i) => {
            const n = source.start_line + i;
            const hit = n >= lo && n <= hi;
            const marker = markers?.get(n);
            const found = findLines?.has(n);
            return (
              <tr
                key={n}
                data-line={n}
                data-highlighted={hit || undefined}
                data-find={found || undefined}
                className={cn(hit && "bg-[var(--hl-line)]", found && !hit && "bg-warn-soft", currentFind === n && "outline outline-1 -outline-offset-1 outline-warn")}
              >
                <td
                  className={cn(
                    "sticky left-0 w-[1%] cursor-pointer border-r border-line bg-code px-3 text-right text-fg-3 select-none hover:text-fg",
                    hit && "text-accent",
                  )}
                  onClick={() => onLineClick?.(n)}
                  title={marker ? `${marker} — line ${n}` : `Line ${n}`}
                >
                  <span className="inline-flex items-center gap-1.5">
                    {marker && <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />}
                    {n}
                  </span>
                </td>
                <td className={cn("px-4 whitespace-pre", hit && "shadow-[inset_2px_0_0_var(--accent)]")} dangerouslySetInnerHTML={{ __html: html || " " }} />
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
