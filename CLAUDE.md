# CLAUDE.md

Guidance for Claude Code in this repository. User and developer docs: [README.md](README.md) (Spanish).

## What this is

A local design editor (pages of shapes, text, images and video) in the spirit of Canva: a Python
server (`app/server.py`, on 127.0.0.1) with a JSON API, a plain-JS editor drawing on Canvas 2D
(`web/`), shown in a pywebview window (`app/desktop.py`) or a browser (`--navegador`). Export
(PNG/JPG/ZIP/PDF) is done with Pillow in `app/exporter.py`.

## Commands

```powershell
.venv\Scripts\python -m app                         # --navegador, --puerto N, --depurar
.venv\Scripts\python -m pytest -q
node --test tests/js/*.test.mjs                     # model + autosave (a bare folder fails on Node 24)
.venv\Scripts\python -m ruff check app tests
build.bat                                           # dist\Lienzo\Lienzo.exe, smoke test, installer
```

## Rules

- **Security is part of the API contract**: the server listens only on 127.0.0.1, every API call
  needs the per-launch `X-Lienzo-Token` header, foreign `Host` headers are rejected, every design
  passes `model.sanitize_design()`, and uploads are checked by signature and size. Keep all of it.
- **Internet downloads go through `app/net.py`** (https only, size/time limits, no private
  addresses); stock photos are re-fetched from Openverse by id, never from a page-supplied URL.
  Local AI accepts only loopback servers (`app/ai.py`).
- `web/js/model.js` has no DOM access, so Node tests it; keep editor geometry, text and history
  logic there rather than in `editor.js`.
- The UI, docs and many identifiers are Spanish (`diseno`, `--navegador`); follow that.
- Tests use a temp data folder (`LIENZO_DATA_DIR`, set in `tests/conftest.py`).

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- When graphify-out/graph.json exists, run `graphify query "<question>"` before your first grep, search or source-file read for a codebase question, and put this rule in every subagent prompt that explores code. Read raw files only for lines the graph or an earlier read already located. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost), then `graphify export wiki` -- the git hooks rebuild graph.json after each commit/checkout but never the wiki.
- graphify-out/ is gitignored: every clone builds its own graph (`/graphify`), and the git hooks (`graphify hook install`) keep it current. Do not commit it or suggest skipping the rebuild or its hooks.
- Community names live in graphify-out/.graphify_labels.json (curated); a community a rebuild creates or reshapes gets a hub-name fallback in `.graphify_labels.pending.json` (e.g. a bare file or test name). When the report shows such names, rename them there (2-5 plain words) and run `graphify cluster-only .`.
