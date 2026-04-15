# Justfile Runner

VS Code / Cursor extension: a **Just** activity bar panel that lists recipes from the workspace `justfile` / `Justfile`, grouped when `just --list` includes `[group]` sections. Run a recipe in a terminal, pin favorites, and save common argument presets.

## Requirements

- [just](https://github.com/casey/just) on your `PATH` (the same environment GUI editors use; macOS GUI sessions often need Homebrew or `~/.local/bin` on `PATH`—the extension prepends common install locations when spawning `just`).
- A workspace folder that contains `justfile` or `Justfile` at the root, or a parent directory of the active editor file that contains one.

## Usage

1. Open the **Just** icon in the activity bar.
2. Use **Recipes** to filter, **Pin** / **Unpin**, optional argument field when the recipe accepts parameters, **Save** for presets, and **Run** to execute `just <recipe> …` in a new terminal.

## Development

```bash
npm install
npm run compile
```

Press F5 in VS Code with this folder opened to launch an Extension Development Host.

## Packaging

```bash
npm run vsix
```

Produces a `.vsix` in this directory. `npm run vscode:prepublish` runs `compile` before marketplace packaging.

## Installing

```bash
cursor
```
<!-- 
## Publishing 

Set `"publisher"` in `package.json` to your [Visual Studio Marketplace](https://marketplace.visualstudio.com/manage) or [Open VSX](https://open-vsx.org/) publisher ID, then use `vsce publish` or the Open VSX CLI. This repository ships as a generic extension; replace publisher and add `repository` if you maintain a public fork. -->
