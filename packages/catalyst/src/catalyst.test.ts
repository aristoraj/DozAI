import { describe, it, expect } from "vitest";
import { buildSelect, buildSelectIds, isDuplicateError } from "./index";

describe("buildSelect", () => {
  it("builds a scoped, ordered, paged query", () => {
    expect(buildSelect("dozai_docs", { tenant_id: "t1", collection: "case", doc_id: "DZ-1" }, 300)).toBe(
      "SELECT uniq_key, tenant_id, collection, doc_id, parent_id, version, body FROM dozai_docs WHERE collection = 'case' AND tenant_id = 't1' AND doc_id = 'DZ-1' ORDER BY version DESC LIMIT 300, 300");
  });
  it("latestOnly asks for one row", () => {
    expect(buildSelect("dozai_docs", { collection: "event", parent_id: "DZ-1", latestOnly: true })).toContain("LIMIT 0, 1");
  });
  it("rejects anything that could change the query", () => {
    expect(() => buildSelect("dozai_docs", { collection: "case", doc_id: "x' OR '1'='1" })).toThrow(/unsafe/);
    expect(() => buildSelect("dozai_docs", { collection: "case", tenant_id: "a b" })).toThrow(/unsafe/);
  });
});

describe("isDuplicateError", () => {
  it("recognises Catalyst duplicate errors", () => {
    expect(isDuplicateError({ code: "DUPLICATE_VALUE", message: "x" })).toBe(true);
    expect(isDuplicateError(new Error("Column value must be unique"))).toBe(true);
    expect(isDuplicateError(new Error("network down"))).toBe(false);
  });
});

describe("buildSelectIds", () => {
  it("selects only row ids, scoped, and refuses unsafe values", () => {
    expect(buildSelectIds("dozai_docs", { collection: "trace", parent_id: "sesn_1" })).toBe("SELECT ROWID FROM dozai_docs WHERE collection = 'trace' AND parent_id = 'sesn_1' LIMIT 0, 300");
    expect(() => buildSelectIds("dozai_docs", { collection: "case", doc_id: "x'; DROP" })).toThrow(/unsafe/);
  });
});
