set positional-arguments

# Cursor / VS Code extensions in this repo (just-run, cursor-context)

# just-run — install deps
[group("cursor-plugins")]
@just-run-install:
    cd "{{ justfile_directory() }}/just-run" && npm install

# just-run — TypeScript compile
[group("cursor-plugins")]
@just-run-compile:
    cd "{{ justfile_directory() }}/just-run" && npm run compile

# just-run — build .vsix
[group("cursor-plugins")]
@just-run-package:
    cd "{{ justfile_directory() }}/just-run" && npm run vsix

# just-run — build .vsix and install into Cursor (`cursor` on PATH)
[group("cursor-plugins")]
@just-run-install-cursor:
    cd "{{ justfile_directory() }}/just-run" && npm run vsix && cursor extension install "$(node -p 'require("./package.json").name + "-" + require("./package.json").version + ".vsix"')"

# cursor-context — install deps
[group("cursor-plugins")]
@cursor-context-install:
    cd "{{ justfile_directory() }}/cursor-context" && npm install

# cursor-context — TypeScript compile
[group("cursor-plugins")]
@cursor-context-compile:
    cd "{{ justfile_directory() }}/cursor-context" && npm run compile

# cursor-context — build .vsix
[group("cursor-plugins")]
@cursor-context-package:
    cd "{{ justfile_directory() }}/cursor-context" && npm run vsix

# cursor-context — build .vsix and install into Cursor (`cursor` on PATH)
[group("cursor-plugins")]
@cursor-context-install-cursor:
    cd "{{ justfile_directory() }}/cursor-context" && npm run vsix && cursor extension install "$(node -p 'require("./package.json").name + "-" + require("./package.json").version + ".vsix"')"

# both plugins
[group("cursor-plugins")]
@cursor-plugins-install: just-run-install cursor-context-install

[group("cursor-plugins")]
@cursor-plugins-compile: just-run-compile cursor-context-compile

[group("cursor-plugins")]
@cursor-plugins-package: just-run-package cursor-context-package

[group("cursor-plugins")]
@cursor-plugins-install-cursor: just-run-install-cursor cursor-context-install-cursor

[group("cursor-plugins")]
cursor-plugins-setup: cursor-plugins-install cursor-plugins-compile
