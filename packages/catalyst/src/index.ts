// Catalyst-specific adapters: Data Store driver and request-scoped SDK access.
// Kept out of @dozai/core so the domain and tests never import the Catalyst SDK.
import catalyst from "zcatalyst-sdk-node";
import { CaseService, DocStore, type DocDriver, type DocQuery, type DocRow } from "@dozai/core";
import type { Policy } from "./types";

const COLS = "uniq_key, tenant_id, collection, doc_id, parent_id, version, body";
const PAGE = 300; // ZCQL returns at most 300 rows per query

const SAFE = /^[A-Za-z0-9_.:\-]+$/;
const lit = (v: string): string => {
  if (!SAFE.test(v)) throw new Error(`unsafe value in query: ${v}`); // identifiers only; bodies never go through ZCQL
  return `'${v}'`;
};

/** Pure, unit-tested SQL builder. */
export function buildSelect(table: string, q: DocQuery, offset = 0): string {
  const where = [`collection = ${lit(q.collection)}`];
  if (q.tenant_id) where.push(`tenant_id = ${lit(q.tenant_id)}`);
  if (q.doc_id) where.push(`doc_id = ${lit(q.doc_id)}`);
  if (q.parent_id) where.push(`parent_id = ${lit(q.parent_id)}`);
  const limit = q.latestOnly ? "0, 1" : `${offset}, ${PAGE}`;
  return `SELECT ${COLS} FROM ${table} WHERE ${where.join(" AND ")} ORDER BY version DESC LIMIT ${limit}`;
}

/** Pure, unit-tested: the ids of the rows a delete would remove. */
export function buildSelectIds(table: string, q: Omit<DocQuery, "latestOnly">): string {
  const where = [`collection = ${lit(q.collection)}`];
  if (q.tenant_id) where.push(`tenant_id = ${lit(q.tenant_id)}`);
  if (q.doc_id) where.push(`doc_id = ${lit(q.doc_id)}`);
  if (q.parent_id) where.push(`parent_id = ${lit(q.parent_id)}`);
  return `SELECT ROWID FROM ${table} WHERE ${where.join(" AND ")} LIMIT 0, ${PAGE}`;
}

export function isDuplicateError(e: unknown): boolean {
  const x = e as { code?: unknown; message?: unknown; name?: unknown } | undefined;
  return /duplicate|unique|already exist/i.test(`${x?.code ?? ""} ${x?.message ?? ""} ${x?.name ?? ""} ${typeof e === "string" ? e : ""}`);
}

type CatalystApp = ReturnType<typeof catalyst.initialize>;

export class CatalystDocDriver implements DocDriver {
  constructor(private app: CatalystApp, private table = "dozai_docs") {}

  async insert(row: DocRow): Promise<boolean> {
    try {
      await this.app.datastore().table(this.table).insertRow({ ...row });
      return true;
    } catch (e) {
      if (isDuplicateError(e)) return false;
      throw e;
    }
  }

  async deleteWhere(q: Omit<DocQuery, "latestOnly">): Promise<number> {
    let total = 0;
    for (;;) {
      // Always read from the start: deleted rows drop out of the result.
      const res = (await this.app.zcql().executeZCQLQuery(buildSelectIds(this.table, q))) as unknown as Record<string, Record<string, string>>[];
      const ids = res.map(r => r[this.table]!.ROWID!).filter(Boolean);
      if (!ids.length) return total;
      for (let i = 0; i < ids.length; i += 100) await this.app.datastore().table(this.table).deleteRows(ids.slice(i, i + 100));
      total += ids.length;
    }
  }

  async select(q: DocQuery): Promise<DocRow[]> {
    const out: DocRow[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const res = (await this.app.zcql().executeZCQLQuery(buildSelect(this.table, q, offset))) as unknown as Record<string, Record<string, string>>[];
      for (const r of res) { const c = r[this.table]!; out.push({ uniq_key: c.uniq_key!, tenant_id: c.tenant_id!, collection: c.collection!, doc_id: c.doc_id!, parent_id: c.parent_id!, version: Number(c.version), body: c.body! }); }
      if (q.latestOnly || res.length < PAGE) break;
    }
    return out;
  }
}

/** Server-side access for a request (admin scope: the API enforces tenant and role itself). */
export function serviceFor(req: unknown, policy?: Policy): CaseService {
  const app = catalyst.initialize(req as never, { scope: "admin" });
  return new CaseService(new DocStore(new CatalystDocDriver(app)), () => new Date(), policy);
}

/** The signed-in Catalyst user's email, or null. */
export async function currentUserEmail(req: unknown): Promise<string | null> {
  try {
    const app = catalyst.initialize(req as never);
    const u = await app.userManagement().getCurrentUser();
    return u?.email_id ? String(u.email_id).toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Invite a person to sign in to this project (Catalyst emails them a link to set a password). */
export async function inviteUser(req: unknown, email: string): Promise<void> {
  const app = catalyst.initialize(req as never, { scope: "admin" });
  const first = email.split("@")[0] ?? "user";
  await app.userManagement().registerUser({ platform_type: "web" } as never, { first_name: first, last_name: "DozAI", email_id: email } as never);
}
