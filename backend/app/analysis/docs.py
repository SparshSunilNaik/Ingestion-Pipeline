"""Split documentation files into heading sections (line-ranged, code-fence aware)."""

from __future__ import annotations

import re
from dataclasses import dataclass

_HEADING = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")
_RST_UNDERLINE = re.compile(r"^([=\-~^\"'`#*+])\1{2,}\s*$")

INSTALL_KEYWORDS = ("install", "setup", "set up", "getting started", "quick start", "quickstart", "requirements", "prerequisite")
USAGE_KEYWORDS = ("usage", "run", "running", "example", "how to use", "start", "deploy", "cli", "commands")
CONFIG_KEYWORDS = ("config", "configuration", "environment", "settings", "env")


@dataclass
class DocSection:
    path: str
    title: str
    level: int
    start_line: int
    end_line: int
    text: str

    def topic(self) -> str | None:
        t = self.title.lower()
        if any(k in t for k in INSTALL_KEYWORDS):
            return "installation"
        if any(k in t for k in CONFIG_KEYWORDS):
            return "configuration"
        if any(k in t for k in USAGE_KEYWORDS):
            return "usage"
        return None


def split_sections(path: str, text: str, max_sections: int = 200) -> list[DocSection]:
    lines = text.splitlines()
    heads: list[tuple[int, int, str]] = []  # (line_no, level, title)
    in_fence = False
    for i, line in enumerate(lines, 1):
        stripped = line.strip()
        if stripped.startswith(("```", "~~~")):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        m = _HEADING.match(line)
        if m:
            heads.append((i, len(m.group(1)), m.group(2).strip()))
        elif path.lower().endswith(".rst") and i > 1 and _RST_UNDERLINE.match(line) and lines[i - 2].strip():
            heads.append((i - 1, 2, lines[i - 2].strip()))
    sections: list[DocSection] = []
    if not heads:
        if lines:
            sections.append(DocSection(path, "(document)", 0, 1, len(lines), text))
        return sections
    if heads[0][0] > 1:
        pre = "\n".join(lines[: heads[0][0] - 1])
        if pre.strip():
            sections.append(DocSection(path, "(preamble)", 0, 1, heads[0][0] - 1, pre))
    for idx, (line_no, level, title) in enumerate(heads):
        end = heads[idx + 1][0] - 1 if idx + 1 < len(heads) else len(lines)
        end = max(end, line_no)
        sections.append(DocSection(path, title[:200], level, line_no, end, "\n".join(lines[line_no - 1 : end])))
        if len(sections) >= max_sections:
            break
    return sections
