/**
 * A tiny recording stand-in for the Supabase client, for unit tests. Every `.from(table)` chain, `.rpc(name)` and
 * `.storage.from(bucket)` call is recorded and answered by a responder function you supply, so a test can say
 * "the print_jobs insert fails" or "this device row exists" without a database.
 *
 *   const fake = fakeSupabase((call) => (call.table === "member_devices" ? { data: row, error: null } : { data: null, error: null }));
 *   await doThing(fake.client as never);
 *   expect(fake.calls.filter((c) => c.op === "insert")).toHaveLength(1);
 *
 * It does NOT model Postgres. It proves what our code asks for and how it reacts to answers, never that the SQL works.
 */
export interface FakeCall {
  /** The table, the rpc function name, or `storage:<bucket>`. */
  table: string;
  op: "select" | "insert" | "update" | "delete" | "upsert" | "rpc" | "download" | "upload" | "remove";
  /** Insert/update payload, rpc args, upload path, or remove paths. */
  values?: unknown;
  /** Column list passed to select(). */
  columns?: string;
  /** Every filter / modifier in call order, e.g. ["eq", "id", "x"]. */
  filters: Array<[string, ...unknown[]]>;
  single?: "single" | "maybeSingle";
}

export interface FakeResult {
  data: unknown;
  error: { message: string } | null;
  count?: number | null;
}

export type Responder = (call: FakeCall) => FakeResult | Promise<FakeResult>;

const FILTERS = ["eq", "neq", "in", "is", "not", "gt", "gte", "lt", "lte", "or", "order", "limit", "range", "match", "contains", "ilike", "like"];

export function fakeSupabase(responder: Responder) {
  const calls: FakeCall[] = [];

  function builder(call: FakeCall) {
    const b: Record<string, unknown> = {};
    for (const name of FILTERS) {
      b[name] = (...args: unknown[]) => {
        call.filters.push([name, ...args]);
        return b;
      };
    }
    // select() after insert/update/delete means "return the rows"; it is not a separate query.
    b.select = (columns?: string) => {
      if (call.op === "select") call.columns = columns ?? "*";
      else call.filters.push(["returning", columns ?? "*"]);
      return b;
    };
    b.single = () => {
      call.single = "single";
      return b;
    };
    b.maybeSingle = () => {
      call.single = "maybeSingle";
      return b;
    };
    b.then = (resolve: (v: FakeResult) => unknown, reject: (e: unknown) => unknown) => {
      calls.push(call);
      return Promise.resolve(responder(call)).then(resolve, reject);
    };
    return b;
  }

  const client = {
    from(table: string) {
      return {
        select: (columns?: string) => builder({ table, op: "select", columns: columns ?? "*", filters: [] }),
        insert: (values: unknown) => builder({ table, op: "insert", values, filters: [] }),
        update: (values: unknown) => builder({ table, op: "update", values, filters: [] }),
        upsert: (values: unknown) => builder({ table, op: "upsert", values, filters: [] }),
        delete: () => builder({ table, op: "delete", filters: [] }),
      };
    },
    rpc(name: string, args?: unknown) {
      return builder({ table: name, op: "rpc", values: args, filters: [] });
    },
    storage: {
      from(bucket: string) {
        const table = `storage:${bucket}`;
        return {
          download: (path: string) => builder({ table, op: "download", values: path, filters: [] }),
          upload: (path: string, bytes: unknown) => builder({ table, op: "upload", values: { path, bytes }, filters: [] }),
          remove: (paths: string[]) => builder({ table, op: "remove", values: paths, filters: [] }),
        };
      },
    },
  };

  return { client, calls };
}

export const ok = (data: unknown = null): FakeResult => ({ data, error: null });
export const failure = (message = "boom"): FakeResult => ({ data: null, error: { message } });
