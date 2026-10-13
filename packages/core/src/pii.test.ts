import { describe, it, expect } from "vitest";
import { normalizeMsisdn } from "./pii";

describe("normalizeMsisdn", () => {
  it("adds the country code to a bare 10-digit number", () => expect(normalizeMsisdn("9876543210")).toBe("919876543210"));
  it("strips punctuation and a leading plus", () => expect(normalizeMsisdn("+91 98765-43210")).toBe("919876543210"));
  it("drops a leading trunk zero", () => expect(normalizeMsisdn("09876543210")).toBe("919876543210"));
  it("leaves numbers that already carry a country code", () => expect(normalizeMsisdn("919876543210")).toBe("919876543210"));
  it("honours another default country code", () => expect(normalizeMsisdn("4155550123", "1")).toBe("14155550123"));
});
