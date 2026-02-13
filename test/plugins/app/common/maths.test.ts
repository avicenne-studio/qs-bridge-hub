import { describe, it, type TestContext } from "node:test";
import { median } from "../../../../src/plugins/app/common/maths.js";

describe("median", () => {
  it("throws on empty array", (t: TestContext) => {
    t.assert.throws(() => median([]), /median of empty array/);
  });

  it("returns single element", (t: TestContext) => {
    t.assert.strictEqual(median([7n]), 7n);
  });

  it("returns middle element for odd length", (t: TestContext) => {
    t.assert.strictEqual(median([3n, 5n, 7n]), 5n);
  });

  it("returns average of two middle for even length", (t: TestContext) => {
    t.assert.strictEqual(median([2n, 4n, 6n, 8n]), 5n);
  });

  it("handles equal values in sort", (t: TestContext) => {
    t.assert.strictEqual(median([5n, 5n, 7n]), 5n);
  });
});
