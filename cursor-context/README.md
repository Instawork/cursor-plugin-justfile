# Cursor Context

VS Code / Cursor extension: an activity bar panel that lists **file-based** Cursor context—project and user rules (`.cursor/rules`, any nesting), slash commands (`.cursor/commands`), **agent prompt markdown** (`.cursor/agents/**/*.md`), **skills** (every `.md` under `.cursor/skills` except paths under `assets/` or `scripts/`, so top-level `*.md`, nested `SKILL.md`, and nested prompts all appear), hooks (`hooks.json` and hook scripts), MCP servers (from `mcp.json`, redacted summaries only), `AGENTS.md`, and legacy `.cursorrules`. Open any file to edit it, or use **Copy path** / **Copy @** to paste references into Agent chat.

There is **no public API** to attach context into Agent chat from an extension; copying the path is the supported workflow.

Part of the [cursor-plugins](https://github.com/Instawork/cursor-plugins) repository.

## Limitations

- **Parallel Agent sessions** (multi-agent UI) are not listed; only paths on disk.
- **Team rules** from the Cursor dashboard are not available to extensions.
- **User rules** created only in Cursor Settings may live outside `~/.cursor/rules`; this panel lists files under `~/.cursor/rules` when that directory exists.
- **`mcp.json`**: the panel shows server id and command/url summary, not env blocks (secrets). Use **Open** on any MCP row to edit the JSON.
- **`findFiles` limits** (500) apply to large repos; increase later if needed.

## Settings

- **`cursor-context.skillGlobs`**: array of extra **absolute** directory paths (you may prefix with `~`). Each directory is scanned recursively for `.md` files using the same rules as project skills (skip `assets/` and `scripts/` segments). Defaults already include `~/.cursor/skills-cursor` and `~/.cursor/skills`.

## Requirements

- Cursor or VS Code `^1.85.0`.
- A workspace folder is optional; without it, only `~/.cursor` items appear.

## Development

From this directory (`cursor-context/`):

```bash
npm install
npm run compile
```

Open the repository root in Cursor/VS Code and choose **Run Extension (cursor-context)** in the Run and Debug view (see root `.vscode/launch.json`).

## Packaging

```bash
npm run vsix
```

Install:

```bash
cursor extension install ./cursor-context-*.vsix
```
