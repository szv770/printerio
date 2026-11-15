/**
 * A small in-memory stand-in for the Supabase client, for route tests that need rows to really change (a claim must move a
 * job from queued to claimed, and a second claim must then find nothing). Supports exactly what the server-jobs routes use:
 * select / insert / update / upsert / delete, eq / in / lt / gt / gte / is / or (the two shapes used) / order / limit,
 * single / maybeSingle, `select(..., { count, head })`. Like fake-supabase.ts it does NOT model Postgres: no constraints
 * (a test can ask for a unique-violation with `failNextInsert`).
 */
export type Row = Record<string, unknown>;

export function memoryDb(initial: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {};
  for (const [k, v] of Object.entries(initial)) tables[k] = v.map((r) => ({ ...r }));
  const log: Array<{ table: string; op: string; values?: unknown; filters: string[] }> = [];
  const state = { failNextInsert: null as null | { message: string; code?: string }, failAll: false, rpcAllows: true };

  const cmp = (a: unknown, b: unknown) => (typeof a === "string" && typeof b === "string" ? (Date.parse(a) < Date.parse(b) ? -1 : Date.parse(a) > Date.parse(b) ? 1 : 0) : (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0);

  function from(table: string) {
    tables[table] ??= [];
    let mode: "select" | "insert" | "update" | "upsert" | "delete" = "select";
    let values: Row | Row[] | null = null;
    let conflict: string | undefined;
    const filters: Array<(r: Row) => boolean> = [];
    const names: string[] = [];
    let orderBy: { col: string; asc: boolean } | null = null;
    let max = Infinity;
    let single: "single" | "maybeSingle" | null = null;
    let head = false;
    let wantCount = false;
    const f = (name: string, fn: (r: Row) => boolean) => (names.push(name), filters.push(fn));

    const q: Record<string, unknown> = {
      select: (_c?: string, opts?: { count?: string; head?: boolean }) => {
        if (opts?.count) wantCount = true;
        if (opts?.head) head = true;
        return q;
      },
      insert: (v: Row | Row[]) => ((mode = "insert"), (values = v), q),
      update: (v: Row) => ((mode = "update"), (values = v), q),
      upsert: (v: Row | Row[], o?: { onConflict?: string }) => ((mode = "upsert"), (values = v), (conflict = o?.onConflict), q),
      delete: () => ((mode = "delete"), q),
      eq: (k: string, v: unknown) => (f(`eq ${k} ${String(v)}`, (r) => r[k] === v), q),
      in: (k: string, vs: unknown[]) => (f(`in ${k}`, (r) => vs.includes(r[k])), q),
      lt: (k: string, v: unknown) => (f(`lt ${k}`, (r) => r[k] != null && cmp(r[k], v) < 0), q),
      gt: (k: string, v: unknown) => (f(`gt ${k}`, (r) => r[k] != null && cmp(r[k], v) > 0), q),
      gte: (k: string, v: unknown) => (f(`gte ${k}`, (r) => r[k] != null && cmp(r[k], v) >= 0), q),
      is: (k: string, v: unknown) => (f(`is ${k}`, (r) => (v === null ? r[k] == null : r[k] === v)), q),
      // status.eq.queued,and(status.eq.claimed,lease_until.lt.<iso>)
      or: (expr: string) => {
        const m = /^status\.eq\.queued,and\(status\.eq\.claimed,lease_until\.lt\.([^)]+)\)$/.exec(expr);
        if (!m) throw new Error(`memoryDb: unsupported or() ${expr}`);
        f(`or ${expr}`, (r) => r.status === "queued" || (r.status === "claimed" && r.lease_until != null && cmp(r.lease_until, m[1]) < 0));
        return q;
      },
      order: (col: string, o?: { ascending?: boolean }) => ((orderBy = { col, asc: o?.ascending !== false }), q),
      limit: (n: number) => ((max = n), q),
      single: () => ((single = "single"), q),
      maybeSingle: () => ((single = "maybeSingle"), q),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        log.push({ table, op: mode, values: values ?? undefined, filters: names });
        return Promise.resolve(run()).then(resolve, reject);
      },
    };

    function run() {
      if (state.failAll) return { data: null, error: { message: "boom" } };
      const rows = tables[table]!;
      const match = () => rows.filter((r) => filters.every((fn) => fn(r)));
      const shape = (list: Row[]) => {
        if (single) {
          if (list.length === 0) return single === "single" ? { data: null, error: { message: "no rows" } } : { data: null, error: null };
          return { data: { ...list[0]! }, error: null };
        }
        return { data: list.map((r) => ({ ...r })), error: null };
      };
      if (mode === "insert") {
        if (state.failNextInsert) {
          const e = state.failNextInsert;
          state.failNextInsert = null;
          return { data: null, error: e };
        }
        const defaults: Row = table === "server_jobs" ? { status: "queued", created_at: new Date().toISOString() } : {};
        const added = (Array.isArray(values) ? values : [values!]).map((v) => ({ id: `gen-${rows.length + 1}`, ...defaults, ...v }));
        rows.push(...added);
        return shape(added);
      }
      if (mode === "upsert") {
        const added: Row[] = [];
        for (const v of Array.isArray(values) ? values : [values!]) {
          const key = conflict ?? "id";
          const at = rows.findIndex((r) => r[key] === v[key]);
          if (at >= 0) Object.assign(rows[at]!, v);
          else rows.push({ ...v });
          added.push({ ...v });
        }
        return shape(added);
      }
      if (mode === "update") {
        const hit = match();
        for (const r of hit) Object.assign(r, values);
        return shape(hit);
      }
      if (mode === "delete") {
        const hit = match();
        tables[table] = rows.filter((r) => !hit.includes(r));
        return shape(hit);
      }
      let list = match();
      if (orderBy) {
        const { col, asc } = orderBy;
        list = [...list].sort((a, b) => (asc ? 1 : -1) * cmp(a[col], b[col]));
      }
      list = list.slice(0, max);
      if (head) return { data: null, error: null, count: match().length };
      const out = shape(list) as { data: unknown; error: unknown; count?: number };
      if (wantCount) out.count = match().length;
      return out;
    }
    return q;
  }

  return { client: { from, rpc: async () => ({ data: state.rpcAllows, error: null }) }, tables: tables as Record<string, Row[]> & Record<"library_pages" | "server_jobs" | "library_fetchers", Row[]>, log, state };
}
