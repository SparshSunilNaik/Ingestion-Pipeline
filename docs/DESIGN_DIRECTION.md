# CODE ATLAS — design direction

*Explore software like a living system.* CODE ATLAS is the visual and interaction identity of Ingestion-Pipeline.

## Why the previous UI felt generic

Inspected in the running app (M6 screenshots in `docs/screenshots/`, browser review on itsdangerous):

1. **No point of attention.** Explorer, canvas and assistant used the same panel colour, the same 1px border and
   the same 12–13px text, so the eye had nowhere to land; the graph looked like one more panel.
2. **A borrowed palette.** Teal-on-graphite with semantic badges everywhere — every chip competed equally.
3. **One typographic voice.** A single UI face at nearly one size; headings, data and labels were not distinct.
4. **The graph was a diagram, not an instrument.** Dagre boxes with a dotted background; selection only dimmed.
   Moving between graph and code reset the view.
5. **The assistant looked like a chat app** bolted onto an analysis tool (bubble avatars, "AI interpretation"
   badges) rather than a research document that cites the code.

## Three directions considered

| Direction | Idea | Originality | Usability | Readability | Feasibility | Verdict |
|---|---|---|---|---|---|---|
| **A. Survey Instrument** | Cartography for code: graphite chart paper, a single lime "signal" colour for whatever is in focus, editorial serif headlines, monospaced legend labels, coordinates (`file:line`) as first-class UI. | High — reads as a map, not a dashboard | High — one accent means one meaning: *this is where you are* | High — dark neutral surfaces, mono for data | High — tokens + typography + graph styling, no new heavy deps | **Chosen** |
| B. Oscilloscope | Phosphor-green CRT, scanlines, glow, animated traces. | Very high | Medium — glow and scanlines tire the eye; contrast drops | Low on long code reading | Medium — needs continuous animation, violates the CPU budget | Rejected |
| C. Paper Blueprint | Light, blueprint-blue line art, drafting fonts. | Medium | High | High in light, weak in dark | High | Rejected — clashes with the dark-first, code-heavy usage |

## The chosen system: Survey Instrument

**Palette** (dark; verified in the browser, contrast-checked by axe):

| Token | Value | Use |
|---|---|---|
| `--bg` | `#101218` | the chart paper |
| `--panel` | `#1B202A` | explorer, assistant, toolbars |
| `--panel-3` | `#252C37` | raised controls, hovered rows |
| `--line` | `#343C4B` | the only border colour |
| `--fg` / `--fg-2` / `--fg-3` | `#E9EEF5` / `#A3ACBC` / `#8A93A3` | text levels |
| `--signal` (`--accent`) | `#D4FA73` | **focus, selection, active relationship, the primary action — nothing else** |
| `--support` | `#8B9CBA` | secondary information, files, legends |

**Typography** (all SIL OFL, loaded with `next/font`, no external requests at runtime):
Geist (UI), Instrument Serif (display moments: landing headline, repository title, section titles of the
briefing), Geist Mono (code, coordinates, legend labels, evidence).

**Legend labels.** Small uppercase mono with wide tracking (`.atlas-label`) — the voice of a map legend — for
section headings, kinds and counts.

**Coordinates.** Every location is shown as `path:line` in mono; clicking it travels there.

**Motion** (`--ease-out: cubic-bezier(.2,.8,.2,1)`, 120 / 200 / 320 ms): only transform/opacity; graph camera
moves glide to a selection; panels and the command palette fade/scale in; nothing animates while idle;
`prefers-reduced-motion` turns all of it into instant changes.

**Rules.** No gradients except the faint radial "lamp" behind the landing headline. No glass. One accent. No
decoration that is not data: the landing motif is the real module map of the last explored repository (or an
abstract, label-free figure on first run).

## Signature interactions

1. **Living graph.** Selecting a node lights its relationships in signal lime, recedes everything else, glides
   the camera to it and opens a detail card with source, callers, dependencies and actions.
2. **Graph ⇄ code round trip.** The graph remembers its camera, selection and filters per snapshot; opening source
   from a node and coming back restores the exact view.
3. **Attached context.** The assistant shows what it is looking at (the selected symbol, file, route or flow) as an
   explicit, removable attachment that the backend validates against the snapshot and puts first in the evidence.
4. **Research document answers.** Answers read as a short document: question, summary, numbered statements with
   coordinate citations and an evidence preview on hover; uncertainty is a visible section.
5. **Focus mode.** `Ctrl+.` hides explorer and assistant to give the canvas the whole screen; layout is remembered.
