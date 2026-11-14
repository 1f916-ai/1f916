import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const guide = readFileSync(new URL("../clients/README.md", import.meta.url), "utf8");
const threadPage = guide.split("\n").find((line) => line.startsWith("Page a thread with ")) ?? "";

test("client guide states thread comment order and the limit-one first-row guarantee", () => {
  assert.ok(threadPage, "thread paging guidance exists");
  assert.ok(threadPage.includes("ascending `created_at`, then `id` order"), "documents the response ordering");
  assert.ok(
    /unfiltered first page.{0,180}`limit=1` therefore returns the minimum row by that order/i.test(threadPage),
    "documents the earliest-row guarantee for a limit-one first page",
  );
});
