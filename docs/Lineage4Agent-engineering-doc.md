---
title: Lineage4Agent
subtitle: A DeepSeek Harness plugin that draws how an agent reached its answer, step by step and subagent by subagent.
owner: Vinicius Dias
repo: github.com/Vnidias/Lineage4Agent_DeepSeek
commit: 14e58df
date: 2026-11-05
version: "0.1.0"
status: Prototype
theme: teal
project_type: other
section_labels:
  "2.3": Data flow and layout
  "2.4": Module details
adaptation_note: Browser plugin with no jobs or notebooks, so 2.3 describes how logs become a graph and 2.4 describes the source files.
how_it_works:
  - {icon: search, title: Open a chat, text: "Use the Lineage tab of a chat, or the Lineage button in the sidebar."}
  - {icon: db, title: Read the logs, text: "Each agent's log and its subagent list are read."}
  - {icon: gear, title: Fold into steps, text: "Events become prompt, step, answer and result cards."}
  - {icon: link, title: Link the agents, text: Each subagent is tied to the step that created it.}
  - {icon: chart, title: Inspect, text: "Click any card for text, tool calls, timing and tokens."}
built_with: [JavaScript, React 18 (shell), DeepSeek Harness client plugins, SVG]
---

# 1 Introduction

## 1.1 Theme

Lineage4Agent (package `dsh-lineage`) is a DeepSeek Harness Web GUI plugin that shows a conversation as a swimlane graph: the prompt, every step and tool call, each subagent and the results that came back. It adds a Lineage tab to every chat and a Lineage button next to Automation tasks. It only reads existing logs.

## 1.2 Problem to be solved

```cards
- {title: Answers hide their path, text: "The chat shows the final answer, not the chain of steps behind it.", icon: search}
- {title: Subagents are scattered, text: "Child agents live in separate chats, so the full tree is hard to follow.", icon: users}
- {title: Flat event ledgers, text: "The Trajectory view lists events of one session, with no cross-agent links.", icon: report}
- {title: Slow debugging, text: "Finding which step or tool failed means reading long transcripts.", icon: alert}
```

## 1.3 Objectives

| ID | Objective | Description | Icon |
| --- | --- | --- | --- |
| O1 | Per-chat lineage | A Lineage tab that draws the open chat as a graph. | chart |
| O2 | Sidebar entry | A Lineage button after Automation tasks to browse any chat. | search |
| O3 | Subagent branches | Show every subagent at any depth, linked to its parent step. | users |
| O4 | Step details | Show text, reasoning, tool calls, timing and tokens per card. | report |
| O5 | Turn focus | Isolate one question and its answer, with the agents that fed it. | target |
| O6 | Read only | Use existing Host read APIs and never write to a session. | lock |
| O7 | No build toolchain | Ship one bundle with no runtime dependencies. | box |

# 2 Development

## 2.1 General architecture

The plugin runs only in the browser. Two entry points render the same graph component. A data module reads logs through the shell's typed Remote client, and the Host answers from the session logs on disk.

<svg viewBox="0 0 700 300" role="img" aria-label="Architecture: the Lineage tab and the Lineage page feed the LineageGraph component, which uses model.js; model.js calls the Remote client, which reaches the Host session controller; the controller reads session logs, which are folded into projections.">
  <defs><marker id="ah1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" style="fill:var(--muted)"/></marker></defs>
  <rect x="10" y="8" width="680" height="142" rx="12" style="fill:none;stroke:var(--accent);stroke-width:1;stroke-dasharray:5 4"/>
  <rect x="10" y="180" width="680" height="112" rx="12" style="fill:none;stroke:var(--muted);stroke-width:1;stroke-dasharray:5 4"/>
  <g style="font:600 12px Inter,sans-serif;fill:var(--muted)">
    <text x="22" y="26">Browser: DSH Web GUI</text>
    <text x="22" y="198">Host: dsh web</text>
  </g>
  <g style="font:600 12px Inter,sans-serif;fill:var(--ink)">
    <rect x="24" y="38" width="140" height="46" rx="9" style="fill:var(--accent-50);stroke:var(--accent);stroke-width:1.5"/>
    <text x="94" y="58" text-anchor="middle">Lineage tab</text>
    <text x="94" y="74" text-anchor="middle" style="font-weight:500;fill:var(--muted)">conversation.view</text>
    <rect x="24" y="96" width="140" height="46" rx="9" style="fill:var(--accent-50);stroke:var(--accent);stroke-width:1.5"/>
    <text x="94" y="116" text-anchor="middle">Lineage page</text>
    <text x="94" y="132" text-anchor="middle" style="font-weight:500;fill:var(--muted)">sidebar + main</text>
    <rect x="200" y="62" width="140" height="56" rx="9" style="fill:var(--accent-100);stroke:var(--accent);stroke-width:1.5"/>
    <use href="#i-chart" x="262" y="68" width="16" height="16" style="color:var(--accent)"/>
    <text x="270" y="100" text-anchor="middle">LineageGraph</text>
    <text x="270" y="113" text-anchor="middle" style="font-weight:500;fill:var(--muted)">ui.js</text>
    <rect x="376" y="62" width="140" height="56" rx="9" style="fill:var(--accent-50);stroke:var(--accent);stroke-width:1.5"/>
    <use href="#i-gear" x="438" y="68" width="16" height="16" style="color:var(--accent)"/>
    <text x="446" y="100" text-anchor="middle">Load, fold, layout</text>
    <text x="446" y="113" text-anchor="middle" style="font-weight:500;fill:var(--muted)">model.js</text>
    <rect x="552" y="62" width="126" height="56" rx="9" style="fill:var(--accent-50);stroke:var(--accent);stroke-width:1.5"/>
    <use href="#i-link" x="607" y="68" width="16" height="16" style="color:var(--accent)"/>
    <text x="615" y="100" text-anchor="middle">Remote client</text>
    <text x="615" y="113" text-anchor="middle" style="font-weight:500;fill:var(--muted)">remote.session</text>
    <rect x="552" y="218" width="126" height="56" rx="9" style="fill:var(--accent-50);stroke:var(--accent);stroke-width:1.5"/>
    <use href="#i-server" x="607" y="224" width="16" height="16" style="color:var(--accent)"/>
    <text x="615" y="258" text-anchor="middle">Session controller</text>
    <rect x="376" y="218" width="140" height="56" rx="9" style="fill:var(--accent-50);stroke:var(--accent);stroke-width:1.5"/>
    <use href="#i-db" x="438" y="224" width="16" height="16" style="color:var(--accent)"/>
    <text x="446" y="256" text-anchor="middle">Session logs</text>
    <text x="446" y="269" text-anchor="middle" style="font-weight:500;fill:var(--muted)">~/.dsh/sessions</text>
    <rect x="200" y="218" width="140" height="56" rx="9" style="fill:var(--accent-50);stroke:var(--accent);stroke-width:1.5"/>
    <use href="#i-sheet" x="262" y="224" width="16" height="16" style="color:var(--accent)"/>
    <text x="270" y="256" text-anchor="middle">Projections</text>
    <text x="270" y="269" text-anchor="middle" style="font-weight:500;fill:var(--muted)">subagentCatalog, title</text>
  </g>
  <g style="stroke:var(--muted);stroke-width:1.5;fill:none">
    <path d="M164 61L182 61L182 82L200 82" marker-end="url(#ah1)"/>
    <path d="M164 119L182 119L182 98L200 98" marker-end="url(#ah1)"/>
    <path d="M340 90L376 90" marker-end="url(#ah1)"/>
    <path d="M516 90L552 90" marker-end="url(#ah1)"/>
    <path d="M615 118L615 218" marker-end="url(#ah1)"/>
    <path d="M552 246L516 246" marker-end="url(#ah1)"/>
    <path d="M376 246L340 246" marker-end="url(#ah1)"/>
  </g>
  <g style="font:500 12px Inter,sans-serif;fill:var(--muted)">
    <text x="606" y="162" text-anchor="end">session/list, session/page,</text>
    <text x="606" y="176" text-anchor="end">session/projections</text>
    <text x="534" y="238" text-anchor="middle">reads</text>
    <text x="358" y="238" text-anchor="middle">folds</text>
  </g>
</svg>

*Figure 1. Runtime architecture: two entry points, one graph component and three read-only Host calls.*
alt: The Lineage tab and the Lineage page feed LineageGraph in ui.js, which uses model.js; model.js calls the Remote client, which reaches the Host session controller; the controller reads the session logs, which are folded into projections.

| Layer | Component | Responsibility |
| --- | --- | --- |
| Entry points | `conversation.view` tab, `sidebar.panellist` button, `main` page | Where the user opens the view |
| UI | LineageGraph, Canvas, Detail (ui.js) | Cards, edges, toolbar, detail panel |
| Data | loadTree, foldSession, buildGraph (model.js) | Read logs, build nodes, lanes, rows and edges |
| Transport | Remote client of the shell | Typed calls to the Host session controller |
| Host | Session controller and persistence | Serve log pages and projections from disk |

## 2.2 Stack

```stack
- {name: JavaScript (ES2022), detail: "4 source modules, no JSX, no compiler", icon: code}
- {name: React 18, detail: "Taken from the shell's shared module table", icon: box}
- {name: DSH client plugin API, detail: "Slots, locale, remote.session, uiWorkspace", icon: gear}
- {name: SVG and CSS, detail: "Edges in SVG; styles use --dsw-* tokens", icon: chart}
- {name: Node.js, detail: "Build script and offline test only", icon: server}
- {name: jsdom and Chromium, detail: "Render test and demo screenshots", icon: check}
```

| Category | Technology | Version |
| --- | --- | --- |
| Host | DeepSeek Harness (`@deepseek-ai/dsh`) | 0.2.2-rc.1 |
| UI runtime | React (provided by the shell) | 18 |
| Plugin package | dsh-lineage | 0.1.0 |
| Bundle | lib/client.js | 67.8 kB, 19.1 kB gzipped |
| Test tooling | jsdom, react-dom 18, Node.js | not pinned |

The package has no runtime dependencies and no peer dependencies. React is resolved through the shell's module loader, so the bundle does not include it.

## 2.3 Data flow and layout

Each time the view opens or refreshes, it runs the same six steps.

```steps
- {title: Resolve the root, text: "In the tab, walk parentSessionId up to the root chat.", icon: search}
- {title: Load the tree, text: "Read each log with session/page and its children from subagentCatalog.", icon: db}
- {title: Fold events, text: "Turn 11 event types into prompt, step, answer and result cards.", icon: gear}
- {title: Link agents, text: "Find the step that spawned each child and where its result landed.", icon: link}
- {title: Lay out, text: "Lanes in depth-first order; rows in time order, below each edge source.", icon: chart}
- {title: Refresh, text: "Reload every 3 s while any agent still has an open turn.", icon: repeat}
```

Children of one agent are loaded concurrently, up to 8 levels deep. History seeded into a forked child before its last `session/end-seed` marker is dropped, so a fork shows only its own work. Injected context messages (time, runtime and skill catalogs) and finished steps with no output are hidden.

| Order | Rule for the spawning step | Edge style |
| --- | --- | --- |
| 1 | A tool call whose result or arguments contain the child id | Solid blue |
| 2 | A delegation call whose run window contains the child's creation time | Solid blue |
| 3 | The parent's last card before the child's creation time | Solid blue |
| Return | A parent message whose sender is the child, else the first parent card after the child ends | Purple dashed (lighter when inferred) |

## 2.4 Module details

The source is 1,575 lines in four modules. The built bundle has 1,599 lines because the build adds a wrapper around them.

```chart
type: hbar
title: Lines of source by file
unit: lines
data:
  - {label: src/ui.js, value: 672}
  - {label: src/model.js, value: 642}
  - {label: src/plugin.js, value: 135}
  - {label: src/styles.js, value: 126}
```

*Figure 2. Lines per source file at commit 14e58df.*
alt: Horizontal bar chart of lines per source file: ui.js 672, model.js 642, plugin.js 135, styles.js 126.

| File | Purpose and key logic | Main exports |
| --- | --- | --- |
| src/model.js | Tree loading, event folding, spawn linking, row assignment, totals; no DOM | loadTree, foldSession, buildGraph, totals |
| src/ui.js | Canvas with pan and zoom, cards, orthogonal edge routing, detail panel, error boundary | LineageGraph, LineageTab, LineagePage, LineageIcon |
| src/plugin.js | Remote adapter, root resolution, slot registrations, labels in 5 languages | apply, inject |
| src/styles.js | Theme-aware CSS using the shell's design tokens | STYLES |
| scripts/build.mjs | Joins the four modules into the DSH ModuleLoader format | (script) |
| demo/ | Standalone page that runs the real bundle on synthetic data | (page) |

## 2.5 Tests

| Area | Check | Status |
| --- | --- | --- |
| Render test (jsdom) | 14 assertions: slots, lanes, edges, detail, links, turn filter, collapse, page | Delivered |
| Offline fold on real logs | test-offline.mjs replays sessions from ~/.dsh/sessions | Delivered |
| Real subagent run | A delegated child in the author's session appears as its own lane with spawn and return edges | Delivered |
| Visual check | Headless Chromium screenshots of the demo, light theme | Partial |
| Live GUI check | Plugin installed and mounted; not yet viewed in an authenticated browser | Not measured |
| Unit tests per function | No test framework | None |
| CI pipeline | No CI configuration | None |

The render test loads `lib/client.js` the same way the shell does, through a stand-in module loader and a fake client context, so it exercises the shipped bundle rather than the sources. The remaining gap is the live GUI check (see Q1).

## 2.6 Results

```kpis
- {value: "5 / 7", label: objectives delivered}
- {value: "2 / 7", label: objectives partial}
- {value: "67.8 kB", label: "bundle, no dependencies"}
- {value: "14", label: render test assertions}
```

| ID | Objective | Status | Evidence |
| --- | --- | --- | --- |
| O1 | Per-chat lineage | Partial | Tab registered and render-tested; not yet seen in the live GUI (Q1) |
| O2 | Sidebar entry | Partial | Panel button at order 11 after Automation tasks (order 10); same live check pending |
| O3 | Subagent branches | Delivered | Demo with 5 agents across 3 levels; real child lane from the author's session |
| O4 | Step details | Delivered | Detail panel shows text, reasoning, tool arguments, results, duration and tokens |
| O5 | Turn focus | Delivered | Filter keeps the turn plus feeding subagents (11 of 20 cards in the test) |
| O6 | Read only | Delivered | Only session/list, session/page and session/projections are called |
| O7 | No build toolchain | Delivered | build.mjs concatenates modules; no runtime dependencies |

## 2.7 Future improvements

| ID | Item | Priority | Effort | Why |
| --- | --- | --- | --- | --- |
| B1 | Confirm both entry points in a live DSH browser session | High | S | O1 and O2 are only render-tested (Q1) |
| B2 | Incremental reads with session/follow instead of full reloads | High | M | Each refresh reads every log in full (R1) |
| B3 | Unit tests for foldSession and buildGraph, plus CI | Medium | M | Only scripted end-to-end checks exist (R4) |
| B4 | Show workflow and code-mode sub-calls as their own cards | Medium | M | Nested calls are summarised in one step |
| B5 | Translate all UI text, not only the tab and button labels | Low | S | Panel and toolbar text is English |
| B6 | Export the graph as SVG or PNG | Low | S | Useful for reports and reviews |
| B7 | Publish to npm and the DSH plugin index | Medium | S | Install currently needs a git clone (Q3) |

# 3 Risks and open questions

## Risks

| ID | Risk | Impact | Mitigation | Priority |
| --- | --- | --- | --- | --- |
| R1 | Very long or deep trees are read in full on every refresh | Slow loading and Host load in live mode | Live refresh runs only while an agent is running; add incremental reads (B2) | Medium |
| R2 | The plugin relies on internal DSH slot and event names | A DSH release can break the view | Error boundary keeps the GUI usable; track DSH releases (Q2) | High |
| R3 | A spawn edge is inferred from timing when no tool result names the child | Edge may point at a nearby step | Rule order prefers explicit ids; inferred returns are drawn lighter | Low |
| R4 | No unit tests or CI | Regressions found late | Run test-render.cjs before each release; add B3 | Medium |
| R5 | The detail panel shows full prompts and tool output | Sensitive text visible on screen | Same data as the chat itself; read only, nothing leaves the Host | Low |

## Open questions

| ID | Question | Owner | Where it matters |
| --- | --- | --- | --- |
| Q1 | Do the tab and sidebar button render as expected in a live authenticated DSH page? | Vinicius Dias | 2.5, O1, O2 |
| Q2 | Will the conversation.view and sidebar.panellist slots stay stable across DSH 0.2 releases? | Not stated | R2 |
| Q3 | Should the plugin be published on npm or a DSH plugin index? | Vinicius Dias | B7 |
| Q4 | What tree size should live mode support before incremental reads are required? | Not stated | R1, B2 |

# Appendix

## Glossary

| Term | Meaning |
| --- | --- |
| DSH | DeepSeek Harness, the agent runtime and Web GUI this plugin extends |
| Subagent | A child agent started by another agent with subagent, subagent_fork or workflow |
| Lane | One column of the graph, holding the cards of a single agent |
| Turn | One prompt or trigger and all the steps until the agent stops |
| Step | One model call plus the tool calls it made |
| Projection | A value the Host folds from a session log, such as subagentCatalog |
| Slot | A named place in the GUI where a plugin can register a component |
| Bundle patch | The cordis.patch.yml layer that mounts the plugin when it is installed |
