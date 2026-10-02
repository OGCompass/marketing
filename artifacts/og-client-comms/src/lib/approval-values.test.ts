import test from "node:test";
import assert from "node:assert/strict";
import { parseValues, badValues } from "./approval-values";

test("multiword and multiline values survive; blanks and edges are trimmed", () => {
  assert.deepEqual(parseValues("Active Client\n\n  Past Client  \r\nHot"), ["Active Client", "Past Client", "Hot"]);
});
test("more than 40 values is reported, never truncated", () => {
  const v = Array.from({ length: 41 }, (_, i) => `v${i}`);
  assert.equal(parseValues(v.join("\n")).length, 41);
  assert.match(badValues({ confirmedValues: v }), /limit is 40/);
});
test("overlong line is reported", () => {
  assert.match(badValues({ confirmedValues: ["x".repeat(121)] }), /120/);
  assert.equal(badValues({ confirmedValues: ["ok"] }), "");
});
