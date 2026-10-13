import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { extractReplyText, matchSignatureVariant, pythonDumps } from "./interakt";

const SECRET = "a".repeat(48);
const sign = (payload: string) => "sha256=" + createHmac("sha256", SECRET).update(payload).digest("hex");
const obj = { type: "message_api_delivered", data: { message: { id: "x", note: "café ₹", n: 1, ok: true, none: null, list: [1, 2] } }, a: "z" };

describe("signature variants", () => {
  it("matches the raw bytes", () => {
    const raw = JSON.stringify(obj);
    expect(matchSignatureVariant(raw, sign(raw), SECRET)).toBe("raw");
  });

  it("matches when the sender signed Python's default json.dumps but transmitted compact JSON", () => {
    const sent = JSON.stringify(obj);
    const signed = pythonDumps(obj);
    expect(sent).not.toBe(signed);
    expect(matchSignatureVariant(sent, sign(signed), SECRET)).toBe("python");
  });

  it("escapes non-ASCII the way Python does", () => {
    expect(pythonDumps({ s: "é₹" })).toBe('{"s": "\\u00e9\\u20b9"}');
  });

  it("matches sorted-key serialisations and tolerates a bare hex or upper-case header", () => {
    const small = { type: "t", data: { message: { id: "x", b: 1 } }, a: "z" };
    const sorted = JSON.stringify({ a: "z", data: { message: { b: 1, id: "x" } }, type: "t" });
    const sent = JSON.stringify(small);
    expect(matchSignatureVariant(sent, sign(sorted), SECRET)).toBe("sorted-compact");
    expect(matchSignatureVariant(sent, sign(sent).replace("sha256=", "").toUpperCase(), SECRET)).toBe("raw");
  });

  it("still rejects a wrong secret, a changed body, and a missing header", () => {
    const raw = JSON.stringify(obj);
    expect(matchSignatureVariant(raw, sign(raw), "b".repeat(48))).toBeNull();
    expect(matchSignatureVariant(JSON.stringify({ ...obj, a: "changed" }), sign(raw), SECRET)).toBeNull();
    expect(matchSignatureVariant(raw, undefined, SECRET)).toBeNull();
    expect(matchSignatureVariant("not json", sign(raw), SECRET)).toBeNull();
  });
});

describe("extractReplyText", () => {
  it("reads plain text and the common button-reply shapes", () => {
    expect(extractReplyText("Yes, continue")).toBe("Yes, continue");
    expect(extractReplyText(JSON.stringify({ text: "No, stop" }))).toBe("No, stop");
    expect(extractReplyText({ button: { text: "Yes, continue", payload: "p" } })).toBe("Yes, continue");
    expect(extractReplyText(JSON.stringify({ interactive: { button_reply: { id: "1", title: "No, stop" } } }))).toBe("No, stop");
    expect(extractReplyText(null)).toBe("");
    expect(extractReplyText({})).toBe("");
  });
});
