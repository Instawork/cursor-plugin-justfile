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
    cursor extension install "$(node -p 'require("./package.json").name + "-" + require("./package.json").version + ".vsix"')"

[group("cursor-plugins")]
just-run: (plugin "just-run")

[group("cursor-plugins")]
cursor-context: (plugin "cursor-context")

[group("cursor-plugins")]
explorer-assist: (plugin "explorer-assist")

# All extensions, in order
[group("cursor-plugins")]
cursor-plugins:
    {{ just_executable() }} plugin just-run
    {{ just_executable() }} plugin cursor-context
    {{ just_executable() }} plugin explorer-assist
