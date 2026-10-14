import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { decryptPhone, InMemoryStore } from "@dozai/core";
import { RefreshingToken, ZOLABS_TOKEN_URL } from "./index";

const KEY = randomBytes(32).toString("base64");

/** A stand-in for the ZoLabs token endpoint: hands out numbered access tokens, and optionally a new refresh token each time. */
function endpoint(o: { rotate?: boolean; fail?: string } = {}) {
  const calls: { url: string; body: URLSearchParams }[] = [];
  let n = 0, rt = 0;
  const fetchFn = (async (url: string, init: { body: string }) => {
    const body = new URLSearchParams(init.body);
    calls.push({ url, body });
    if (o.fail) return { ok: false, status: 400, json: async () => ({ error: o.fail }) };
    return { ok: true, status: 200, json: async () => ({ access_token: `access-${++n}`, expires_in: 3600, ...(o.rotate ? { refresh_token: `refresh-${++rt + 1}` } : {}) }) };
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}
const make = (e: ReturnType<typeof endpoint>, now = { t: 1_000_000 }) => ({ now, auth: new RefreshingToken({ clientId: "client-1", refreshToken: "refresh-1", piiKey: KEY, fetch: e.fetchFn, now: () => now.t }) });

describe("staying signed in to ZoLabs", () => {
  it("trades the one-time sign-in token for an access token, asking ZoLabs as a public client", async () => {
    const e = endpoint(); const { auth } = make(e);
    expect(await auth.token()).toBe("access-1");
    expect(e.calls[0]!.url).toBe(ZOLABS_TOKEN_URL);
    expect(Object.fromEntries(e.calls[0]!.body)).toEqual({ grant_type: "refresh_token", refresh_token: "refresh-1", client_id: "client-1" });
  });

  it("reuses the access token until shortly before it expires, then renews", async () => {
    const e = endpoint(); const { auth, now } = make(e);
    await auth.token(); now.t += 3000 * 1000;
    expect(await auth.token()).toBe("access-1");
    now.t += 600 * 1000; // 3600 seconds in, inside the safety margin
    expect(await auth.token()).toBe("access-2");
    expect(e.calls).toHaveLength(2);
  });

  it("many calls at the same moment share one renewal", async () => {
    const e = endpoint(); const { auth } = make(e);
    const all = await Promise.all(Array.from({ length: 6 }, () => auth.token()));
    expect(new Set(all).size).toBe(1);
    expect(e.calls).toHaveLength(1);
  });

  it("keeps a newer refresh token in the database, encrypted, and uses it from then on", async () => {
    const e = endpoint({ rotate: true }); const { auth, now } = make(e);
    const store = new InMemoryStore(); auth.attach(store);
    await auth.token();
    const saved = (await store.getSecret("zolabs_refresh_token"))!;
    expect(saved).not.toContain("refresh-2"); // never stored as plain text
    expect(decryptPhone(KEY, saved)).toBe("refresh-2");
    now.t += 4000 * 1000;
    await auth.token();
    expect(e.calls[1]!.body.get("refresh_token")).toBe("refresh-2"); // the renewed one, not the original
  });

  it("a second copy of the server uses the token the first one saved", async () => {
    const e1 = endpoint({ rotate: true }); const a = make(e1).auth;
    const store = new InMemoryStore(); a.attach(store);
    await a.token();
    const e2 = endpoint(); const b = make(e2).auth; b.attach(store);
    await b.token();
    expect(e2.calls[0]!.body.get("refresh_token")).toBe("refresh-2");
  });

  it("says plainly what to do when ZoLabs refuses, and does not retry forever", async () => {
    const e = endpoint({ fail: "invalid_grant" }); const { auth } = make(e);
    await expect(auth.token()).rejects.toThrow(/could not be renewed \(invalid_grant\).*zolabs-login\.mjs/);
    expect(e.calls).toHaveLength(1);
  });

  it("when it lost a race with another copy, it tries once more with the token that copy saved", async () => {
    const store = new InMemoryStore();
    const { encryptPhone } = await import("@dozai/core");
    let first = true;
    const calls: string[] = [];
    const fetchFn = (async (_u: string, init: { body: string }) => {
      const t = new URLSearchParams(init.body).get("refresh_token")!; calls.push(t);
      if (first) { first = false; await store.putSecret("zolabs_refresh_token", encryptPhone(KEY, "refresh-9")); return { ok: false, status: 400, json: async () => ({ error: "invalid_grant" }) }; }
      return { ok: true, status: 200, json: async () => ({ access_token: "access-ok", expires_in: 3600 }) };
    }) as unknown as typeof fetch;
    const auth = new RefreshingToken({ clientId: "c", refreshToken: "refresh-1", piiKey: KEY, fetch: fetchFn });
    auth.attach(store);
    expect(await auth.token()).toBe("access-ok");
    expect(calls).toEqual(["refresh-1", "refresh-9"]);
  });
});
