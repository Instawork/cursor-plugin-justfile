# Workflow Studio

Cursor/VS Code custom editor for Mermaid workflow graphs (`.mmd`) with node-bound Markdown prompts.

There is **no activity-bar icon**. This is an editor for `.mmd` files, not a sidebar panel.

## How to open (pick one)

1. **Command Palette** (`⌘⇧P`):
   - `Workflow Studio: Open Workflow File…` — pick any `.mmd`
   - `Workflow Studio: Open in Workflow Studio` — reopen the current `.mmd` in the studio
2. **Explorer**: right-click a `.mmd` → **Open in Workflow Studio**
3. **Editor tab**: with a `.mmd` open as text, use the title-bar **Open in Workflow Studio** action, or right-click the editor → **Open in Workflow Studio**
4. Classic: right-click the tab → **Open With…** → **Workflow Studio**

After it opens you should see three panes: structure rail | Mermaid graph | prompt editor. Click a node (or rail row) to load its bound markdown.

## Directives

```text
%% @prompt Triage -> steps/01-task-picker.md
%% @prompt Confirm -> steps/02-prod-confirm.md
```

Paths are relative to the `.mmd` directory. Unsafe/out-of-workspace/`*secret*`/`.env*`/`src/config/local.py` targets are blocked.

## Install

From the monorepo root:

```bash
just workflow-studio
# or
just plugin workflow-studio
```

Then **Developer: Reload Window** so Cursor picks up the new commands.

## Develop

```bash
cd workflow-studio
npm install
npm test
npm run compile
npm run vsix
```
