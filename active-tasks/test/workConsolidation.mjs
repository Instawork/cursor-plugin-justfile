import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const {
  titlesNearDuplicate,
  findSemanticDuplicate,
  suggestStructuralMerges,
  DEFAULT_DEDUP_SIMILARITY,
} = require(join(root, "out/workConsolidation.js"));

test("titlesNearDuplicate matches MEMORY_DEDUP_SIMILARITY token-set rules", () => {
  const base =
    "fix active tasks done panel rendering performance layout nest collapse";
  assert.equal(titlesNearDuplicate(base, base), true);
  // Near-identical: many shared tokens, one trailing difference → ≥ 0.9.
  const shared =
    "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo";
  assert.equal(
    titlesNearDuplicate(shared + " sierra", shared + " tango"),
    true
  );
  assert.equal(titlesNearDuplicate("short one", "short two"), false);
  assert.equal(
    titlesNearDuplicate(
      "Completely unrelated payroll tax filing work item",
      base
    ),
    false
  );
  assert.equal(DEFAULT_DEDUP_SIMILARITY, 0.9);
});

test("findSemanticDuplicate hits shared PR then refuses done", () => {
  const open = {
    id: "a",
    label: "Ship feature",
    title: "Ship feature alpha release path",
    done: false,
    repo: "finch",
    pr_number: 42,
    pr_url: "https://github.com/org/finch/pull/42",
  };
  const hitOpen = findSemanticDuplicate(
    { title: "Other", repo: "finch", pr_number: 42 },
    [open]
  );
  assert.ok(hitOpen);
  assert.equal(hitOpen.reasonCode, "shared_pr");
  assert.equal(hitOpen.todo.id, "a");

  const done = { ...open, id: "b", done: true, done_at: new Date().toISOString() };
  const hitDone = findSemanticDuplicate(
    { title: "Other", repo: "finch", pr_number: 42 },
    [done]
  );
  assert.ok(hitDone);
  assert.equal(hitDone.todo.done, true);
});

test("findSemanticDuplicate title near-dup against recent done", () => {
  const base =
    "fix active tasks done panel rendering performance layout nest collapse";
  const done = {
    id: "d1",
    label: base,
    title: base,
    done: true,
    done_at: new Date().toISOString(),
    repo: "cursor-plugin-justfile",
  };
  const hit = findSemanticDuplicate(
    {
      title: base,
      repo: "cursor-plugin-justfile",
    },
    [done]
  );
  assert.ok(hit);
  assert.equal(hit.reasonCode, "title_near");
  assert.equal(hit.todo.id, "d1");
});

test("suggestStructuralMerges uses shared PR without all-pairs blowup", () => {
  const words = [
    "alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel",
    "india", "juliet", "kilo", "lima", "mike", "november", "oscar", "papa",
    "quebec", "romeo", "sierra", "tango", "uniform", "victor", "whiskey",
    "xray", "yankee", "zulu", "amber", "birch", "cedar", "daisy", "elmwood",
    "fern", "grove", "hazel", "ivory", "jade", "kelp", "lotus", "maple", "nimbus",
  ];
  const todos = words.map((w, i) => ({
    id: "solo-" + i,
    label: w,
    title: "Distinct " + w + " initiative copper silver bronze platinum",
    done: false,
    repo: "finch",
    branch: "feat/" + w,
  }));
  todos.push({
    id: "p1",
    label: "Shared pr left",
    title: "Shared pr left side title here",
    done: false,
    repo: "finch",
    pr_number: 99,
  });
  todos.push({
    id: "p2",
    label: "Shared pr right",
    title: "Shared pr right side title here",
    done: false,
    repo: "finch",
    pr_number: 99,
  });
  const suggestions = suggestStructuralMerges(todos);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].reasonCode, "shared_pr");
  assert.equal(suggestions[0].mergeIds.length, 1);
});
