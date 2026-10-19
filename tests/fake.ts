// Tiny in-memory stand-in for firebase-admin + Firestore. Transactions commit atomically.
// It does NOT emulate security rules, indexes or true concurrency.
export const store = new Map<string, any>();
const ver = new Map<string, number>(); // per-document write counter, used to emulate Firestore's transaction conflict + retry
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
    ver.set(o.path, (ver.get(o.path) || 0) + 1);
    if (o.op === "delete") store.delete(o.path);
    else if (o.op === "create") store.set(o.path, resolve(o.d));
    else if (o.op === "set") store.set(o.path, o.o?.merge ? { ...(old || {}), ...resolve(o.d) } : resolve(o.d));
    else store.set(o.path, applyUpdate(old, o.d));
  }
}
const snap = (path: string): any => { const d = store.get(path); return { id: path.split("/").pop(), exists: d !== undefined, ref: ref(path), data: () => (d === undefined ? undefined : clone(d)) }; };
const ref = (path: string): any => ({ id: path.split("/").pop(), path, get: async () => snap(path),
  set: async (d: any, o?: any) => commit([{ op: "set", path, d, o }]), update: async (d: any) => commit([{ op: "update", path, d }]), create: async (d: any) => commit([{ op: "create", path, d }]),
  delete: async () => { if (store.delete(path)) ver.set(path, (ver.get(path) || 0) + 1); } });
const cmp = (x: any, op: string, v: any) => { const a = x?.toMillis ? x.toMillis() : x, b = v?.toMillis ? v.toMillis() : v;
  return op === "==" ? a === b : op === "!=" ? a !== b : op === "in" ? v.includes(x) : op === "not-in" ? !v.includes(x) : op === "array-contains" ? Array.isArray(x) && x.includes(v)
    : op === ">" ? a > b : op === ">=" ? a >= b : op === "<" ? a < b : op === "<=" ? a <= b : false; };
const query = (col: string, filters: any[] = [], order: any = null, lim = Infinity, after: string | null = null): any => ({
  where: (f: string, op: string, v: any) => query(col, [...filters, [f, op, v]], order, lim, after),
  orderBy: (f: string, dir = "asc") => query(col, filters, [f, dir], lim, after),
  limit: (n: number) => query(col, filters, order, n, after),
  startAfter: (s: any) => query(col, filters, order, lim, s.id),
  get: async () => {
    let docs = [...store.keys()].filter(p => p.startsWith(col + "/") && !p.slice(col.length + 1).includes("/")).map(snap)
      .filter(s => filters.every(([f, op, v]) => cmp(s.data()[f], op, v)));
    if (order) { const k = (s: any) => { if (order[0] === "__name__") return s.id; const x = s.data()[order[0]]; return x?.toMillis ? x.toMillis() : x; }; docs.sort((a, b) => (k(a) > k(b) ? 1 : k(a) < k(b) ? -1 : 0) * (order[1] === "desc" ? -1 : 1)); }
    if (after) { const i = docs.findIndex(d => d.id === after); docs = i < 0 ? docs : docs.slice(i + 1); }
    docs = docs.slice(0, lim);
    return { docs, empty: !docs.length, size: docs.length };
  } });
const db = {
  doc: (p: string) => ref(p),
  collection: (c: string) => ({ ...query(c), doc: (id?: string) => ref(`${c}/${id || "auto" + ++auto}`), add: async (d: any) => { const r = ref(`${c}/auto${++auto}`); await r.create(d); return r; } }),
  batch: () => { const ops: any[] = []; const b: any = { set: (r: any, d: any, o?: any) => (ops.push({ op: "set", path: r.path, d, o }), b), update: (r: any, d: any) => (ops.push({ op: "update", path: r.path, d }), b),
    create: (r: any, d: any) => (ops.push({ op: "create", path: r.path, d }), b), delete: (r: any) => (ops.push({ op: "delete", path: r.path }), b),
    commit: async () => { if (ops.length > 500) throw err("INVALID_ARGUMENT: too many writes in one batch", 3); commit(ops); } }; return b; },
  // Optimistic concurrency like the real thing: if any document read by the transaction changed before commit, the callback runs again.
  runTransaction: async (fn: any) => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const ops: any[] = [], reads = new Map<string, number>();
      const seenRead = (s: any) => { if (s.ref && s.ref.path && s.exists !== undefined) reads.set(s.ref.path, ver.get(s.ref.path) || 0); else for (const d of s.docs || []) reads.set(d.ref.path, ver.get(d.ref.path) || 0); };
      const t = { get: async (r: any) => { if (r.path) reads.set(r.path, ver.get(r.path) || 0); const s = await r.get(); if (!r.path) seenRead(s); return s; },
        set: (r: any, d: any, o?: any) => ops.push({ op: "set", path: r.path, d, o }), update: (r: any, d: any) => ops.push({ op: "update", path: r.path, d }),
        create: (r: any, d: any) => ops.push({ op: "create", path: r.path, d }), delete: (r: any) => ops.push({ op: "delete", path: r.path }) };
      const stale = () => [...reads].some(([p, v]) => (ver.get(p) || 0) !== v);
      let out: any;
      try { out = await fn(t); } catch (e) { if (stale()) continue; throw e; }
      if (stale()) continue;
      if (ops.length > 500) throw err("INVALID_ARGUMENT: too many writes in one transaction", 3);
      commit(ops); return out;
    }
    throw err("ABORTED: too much contention", 10);
  } };
// Controllable stand-in for the Firebase Authentication admin API (tests flip these to simulate failures).
export const authState = { deleted: [] as string[], disabled: [] as string[], revoked: [] as string[], failDelete: 0, missing: new Set<string>() };
const authErr = (code: string) => Object.assign(new Error(code), { code });
export const fake: any = { initializeApp() {}, credential: { cert: () => ({}) },
  auth: () => ({ verifyIdToken: async (t: string) => { if (!t.startsWith("tok:")) throw new Error("bad token"); return { uid: t.slice(4), email: t.slice(4) + "@x.test" }; },
    updateUser: async (uid: string, p: any) => { if (authState.missing.has(uid) || authState.deleted.includes(uid)) throw authErr("auth/user-not-found"); if (p?.disabled) authState.disabled.push(uid); return {}; },
    revokeRefreshTokens: async (uid: string) => { authState.revoked.push(uid); },
    deleteUser: async (uid: string) => { if (authState.failDelete > 0) { authState.failDelete--; throw authErr("auth/internal-error"); }
      if (authState.missing.has(uid) || authState.deleted.includes(uid)) throw authErr("auth/user-not-found"); authState.deleted.push(uid); } }) };
fake.firestore = Object.assign(() => db, { FieldValue: { serverTimestamp: () => SERVER, increment: (n: number) => ({ __inc: n }) }, FieldPath: { documentId: () => "__name__" } });
