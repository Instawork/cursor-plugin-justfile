import assert from "node:assert/strict";
import { test } from "node:test";
import {
  filterMissingPrsForFeed,
  filterUntrackedCloudForFeed,
  prActivityMs,
} from "../out/reconcileFeedFilter.js";

test("filterMissingPrsForFeed skips old PRs when watermark set", () => {
  const wm = Date.parse("2026-01-01T00:00:00.000Z");
  const prs = [
    {
      number: 1,
      title: "old",
      url: "https://github.com/a/b/pull/1",
      nameWithOwner: "a/b",
      repoKey: null,
      relation: "authored",
      isDraft: false,
      updatedAt: "2025-06-01T00:00:00.000Z",
    },
    {
      number: 2,
      title: "new",
      url: "https://github.com/a/b/pull/2",
      nameWithOwner: "a/b",
      repoKey: null,
      relation: "authored",
      isDraft: false,
      updatedAt: "2026-02-01T00:00:00.000Z",
    },
  ];
  const out = filterMissingPrsForFeed(prs, wm);
  assert.equal(out.length, 1);
  assert.equal(out[0].number, 2);
});

test("filterMissingPrsForFeed passes all when watermark null", () => {
  const prs = [{ number: 1, updatedAt: "2020-01-01T00:00:00.000Z" }];
  assert.equal(
    filterMissingPrsForFeed(prs, null).length,
    1
  );
});

test("prActivityMs prefers updatedAt", () => {
  assert.equal(
    prActivityMs({
      number: 1,
      title: "t",
      url: "u",
      nameWithOwner: "a/b",
      repoKey: null,
      relation: "authored",
      isDraft: false,
      updatedAt: "2026-03-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
    Date.parse("2026-03-01T00:00:00.000Z")
  );
});

test("filterUntrackedCloudForFeed respects watermark", () => {
  const wm = 1000;
  const agents = [
    { agentId: "bc-old", lastModified: 500 },
    { agentId: "bc-new", lastModified: 2000 },
  ];
  const out = filterUntrackedCloudForFeed(agents, wm);
  assert.equal(out.length, 1);
  assert.equal(out[0].agentId, "bc-new");
});
