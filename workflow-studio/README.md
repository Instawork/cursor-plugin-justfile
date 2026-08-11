# Workflow Studio

Cursor/VS Code custom editor for Mermaid workflow graphs (`.mmd`) with node-bound Markdown prompts.

There is **no activity-bar icon**. This is an editor for `.mmd` files, not a sidebar panel.

## How to open (pick one)

1. **Command Palette** (`⌘⇧P`):
   - `Workflow Studio: Open Cursor Workflow…` — lists every `.mmd` under workspace `.cursor/` (installed packs)
   - `Workflow Studio: Open Workflow File…` — same list, plus Browse…
   - `Workflow Studio: Open in Workflow Studio` — reopen the current `.mmd` in the studio
2. **Double-click / Open** a `.mmd` — Workflow Studio is the **default** editor for `*.mmd`
3. **Explorer**: right-click a `.mmd` → **Open in Workflow Studio**
4. Classic: right-click the tab → **Open With…** → **Workflow Studio**

Packs dropped under `.cursor/` (for example `.cursor/sre-orchestrator/**/*.mmd`) show up in **Open Cursor Workflow…** via the glob `.cursor/**/*.mmd`. Creating a new `.mmd` there offers an Open toast (setting: `workflowStudio.notifyOnNewCursorWorkflow`).

After it opens you should see three panes: structure rail | Mermaid graph (via [beautiful-mermaid](https://www.npmjs.com/package/beautiful-mermaid)) | prompt editor. Click a node (or rail row) to load its bound markdown.

## Binding prompts

Unbound nodes show a **Bind prompt** card:

- **Create prompt file** — writes `steps/<NodeId>.md` and inserts `%% @prompt NodeId -> steps/<NodeId>.md`
- **Link existing…** — pick a markdown file under the workspace
- **Open .mmd as text** — edit directives by hand

Empty workflows can use **Insert starter workflow** (three nodes + bindings).

## Directives

```text
%% @prompt Triage -> steps/01-task-picker.md
%% @prompt Confirm -> steps/02-prod-confirm.md
```

Paths are relative to the `.mmd` directory. Unsafe/out-of-workspace/`*secret*`/`.env*`/`src/config/local.py` targets are blocked.

## Shortcuts

| Action | Shortcut |
|--------|----------|
| Save prompt (flush autosave) | `⌘S` / `Ctrl+S` |
| Reset zoom | `⌘0` / `Ctrl+0` |
| Zoom (graph) | `⌘`/`Ctrl` + mouse wheel |
| Filter structure | `⌘F` / `Ctrl+F` (when not in prompt editor) |
| Move selection | `↑` / `↓` |
| Focus prompt | `Enter` (with a selection) |

Command Palette also has: Bind Selected Node, Next Unbound Node, Focus Structure/Graph/Prompt.

Graph toolbar: **Fit · 100% · + · −**. Drag empty graph space to pan.

## Install

From the monorepo root:

```bash
just workflow-studio
# or
just plugin workflow-studio
```

Then **Developer: Reload Window** so Cursor picks up the new commands.

## Develop / test

```bash
cd workflow-studio
npm install
npm test          # compile + node --test test/*.mjs
npm run compile
npm run vsix
```

`npm test` covers directives, path safety, bindDirective, structureModel, panZoom, railModel, messages, promptSession, and webviewHtml.
