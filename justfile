# Example justfile for this repo: use the Just panel while developing the extension.

[group('deps')]
install:
    npm install

[group('build')]
compile:
    npm run compile

watch:
    npm run watch

[group('package')]
vsix:
    npm run vsix

default: compile
