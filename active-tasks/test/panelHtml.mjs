import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const html = readFileSync(
  join(import.meta.dirname, "..", "media", "active-tasks-panel.html"),
  "utf8"
);

test("list grouping is an explicit picker", () => {
  assert.match(html, /<select id="groupSelect"/);
  assert.match(html, /value="list">None/);
  assert.match(html, /value="repo">Repository/);
  assert.match(html, /value="status">Status/);
  assert.doesNotMatch(html, /id="groupToggle"/);
});

test("board cards expose list-equivalent mutations", () => {
  assert.match(html, /makeCardPinButton\(todo, "board-card-pin-btn"\)/);
  assert.match(html, /makeCardDoneButton\(todo, "board-card-done-btn"\)/);
  assert.match(html, /editableText\(todo, "title"/);
  assert.match(html, /editableText\(todo, "next_action"/);
  assert.match(
    html,
    /applyNest\(draggedId, card\.dataset\.id, card\.dataset\.group, true\)/
  );
  assert.match(html, /statusGroupSync\(card\.dataset\.group\)/);
});
