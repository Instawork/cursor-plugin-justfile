# Cursor / VS Code extensions in this repo (just-run, cursor-context, explorer-assist)

# Build and install one extension into Cursor (`cursor` on PATH).
[group("cursor-plugins")]
plugin name:
    #!/usr/bin/env bash
    set -euo pipefail
    cd "{{ justfile_directory() }}/{{ name }}"
    npm install
    npm run compile
    npm run vsix
    # Cursor CLI: use --install-extension (not `cursor extension  install`, which is a no-op on current builds).
    EXT_ID="$(node -p 'require("./package.json").publisher + "." + require("./package.json").name')"
    cursor --uninstall-extension "$EXT_ID" 2>/dev/null || true
    VSIX="$(pwd)/$(node -p 'require("./package.json").name + "-" + require("./package.json").version + ".vsix"')"
    cursor --install-extension "$VSIX" 

[group("cursor-plugins")]
just-run: (plugin "just-run")

[group("cursor-plugins")]
cursor-context: (plugin "cursor-context")

[group("cursor-plugins")]
explorer-assist: (plugin "explorer-assist")

[group("cursor-plugins")]
side-dock: (plugin "side-dock")

# All extensions, in order
[group("cursor-plugins")]
cursor-plugins:
    {{ just_executable() }} plugin just-run
    {{ just_executable() }} plugin cursor-context
    {{ just_executable() }} plugin explorer-assist
    {{ just_executable() }} plugin side-dock
    {{ just_executable() }} plugin search-workspace-settings
    {{ just_executable() }} plugin token-telemetry
    {{ just_executable() }} plugin active-tasks
    {{ just_executable() }} plugin workflow-studio

[group("cursor-plugins")]
search-workspace-settings: (plugin "search-workspace-settings")

[group("cursor-plugins")]
token-telemetry: (plugin "token-telemetry")

[group("cursor-plugins")]
active-tasks: (plugin "active-tasks")

[group("cursor-plugins")]
workflow-studio: (plugin "workflow-studio")
