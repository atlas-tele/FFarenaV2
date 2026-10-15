// Tiny in-memory stand-in for firebase-admin + Firestore. Transactions commit atomically.
// It does NOT emulate security rules, indexes or true concurrency.
export const store = new Map<string, any>();
let auto = 0;
const SERVER = { __sv: true };
const ts = (ms = Date.now()) => ({ __ts: true, toMillis: () => ms, toDate: () => new Date(ms) });
const plain = (v: any) => v && typeof v === "object" && !Array.isArray(v) && !Buffer.isBuffer(v) && !(v instanceof Date) && !v.__ts && !v.__sv && v.__inc === undefined;
const clone = (v: any): any => (Array.isArray(v) ? v.map(clone) : plain(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)])) : v);
const resolve = (v: any, old?: any): any => (v && v.__sv ? ts() : v && v.__inc !== undefined ? (old || 0) + v.__inc : plain(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x)])) : Array.isArray(v) ? v.map(x => resolve(x)) : v);
function applyUpdate(old: any, upd: any) {
  const d = clone(old);
  for (const [k, v] of Object.entries(upd)) {
    const path = k.split("."); let o = d;
    for (const p of path.slice(0, -1)) o = o[p] = o[p] && typeof o[p] === "object" ? o[p] : {};
    o[path[path.length - 1]] = resolve(v, o[path[path.length - 1]]);
  }
  return d;
}
const err = (m: string, code: number) => Object.assign(new Error(m), { code });
function commit(ops: any[]) {
  const seen = new Set<string>();
  for (const o of ops) {
    if (o.op === "create") { if (store.has(o.path) || seen.has(o.path)) throw err("ALREADY_EXISTS", 6); seen.add(o.path); }
    if (o.op === "update" && !store.has(o.path) && !seen.has(o.path)) throw err("NOT_FOUND", 5);
  }
  for (const o of ops) {
    const old = store.get(o.path);
    if (o.op === "create") store.set(o.path, resolve(o.d));
    else if (o.op === "set") store.set(o.path, o.o?.merge ? { ...(old || {}), ...resolve(o.d) } : resolve(o.d));
    else store.set(o.path, applyUpdate(old, o.d));
  }
}
const snap = (path: string): any => { const d = store.get(path); return { id: path.split("/").pop(), exists: d !== undefined, ref: ref(path), data: () => (d === undefined ? undefined : clone(d)) }; };
const ref = (path: string): any => ({ id: path.split("/").pop(), path, get: async () => snap(path),
  set: async (d: any, o?: any) => commit([{ op: "set", path, d, o }]), update: async (d: any) => commit([{ op: "update", path, d }]), create: async (d: any) => commit([{ op: "create", path, d }]),
  delete: async () => { store.delete(path); } });
const query = (col: string, filters: any[] = [], order: any = null, lim = Infinity): any => ({
  where: (f: string, op: string, v: any) => query(col, [...filters, [f, op, v]], order, lim),
  orderBy: (f: string, dir = "asc") => query(col, filters, [f, dir], lim),
  limit: (n: number) => query(col, filters, order, n),
  get: async () => {
    let docs = [...store.keys()].filter(p => p.startsWith(col + "/") && !p.slice(col.length + 1).includes("/")).map(snap)
      .filter(s => filters.every(([f, op, v]) => { const x = s.data()[f]; return op === "==" ? x === v : op === "in" ? v.includes(x) : op === "array-contains" ? Array.isArray(x) && x.includes(v) : false; }));
    if (order) { const k = (s: any) => { const x = s.data()[order[0]]; return x?.toMillis ? x.toMillis() : x; }; docs.sort((a, b) => (k(a) > k(b) ? 1 : k(a) < k(b) ? -1 : 0) * (order[1] === "desc" ? -1 : 1)); }
    docs = docs.slice(0, lim);
    return { docs, empty: !docs.length, size: docs.length };
  } });
const db = {
  doc: (p: string) => ref(p),
  collection: (c: string) => ({ ...query(c), doc: (id?: string) => ref(`${c}/${id || "auto" + ++auto}`), add: async (d: any) => { const r = ref(`${c}/auto${++auto}`); await r.create(d); return r; } }),
  runTransaction: async (fn: any) => {
    const ops: any[] = [];
    const t = { get: async (r: any) => r.get(), set: (r: any, d: any, o?: any) => ops.push({ op: "set", path: r.path, d, o }), update: (r: any, d: any) => ops.push({ op: "update", path: r.path, d }), create: (r: any, d: any) => ops.push({ op: "create", path: r.path, d }) };
    const out = await fn(t); commit(ops); return out;
  } };
export const fake: any = { initializeApp() {}, credential: { cert: () => ({}) },
  auth: () => ({ verifyIdToken: async (t: string) => { if (!t.startsWith("tok:")) throw new Error("bad token"); return { uid: t.slice(4), email: t.slice(4) + "@x.test" }; } }) };
fake.firestore = Object.assign(() => db, { FieldValue: { serverTimestamp: () => SERVER, increment: (n: number) => ({ __inc: n }) } });
