// transports.js — app-specific adapters that bridge SyncEngine's generic
// pull()/push() to each dooo-api endpoint's concrete HTTP contract.
//
// The engine is transport-agnostic; these adapters own the URL shape, auth, and
// the record<->wire mapping. dooo-api deliberately preserved the old Apps Script
// contract, so the to.dooo adapter is a faithful port of the existing client.

// Shared fetch helpers ---------------------------------------------------------

function withQuery(base, params) {
  const sep = base.includes("?") ? "&" : "?";
  const qs = Object.entries(params)
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
  return qs ? base + sep + qs : base;
}

// to.dooo ----------------------------------------------------------------------
//
// GET  <base>?token=<t>&_=<ts>          -> { ok, todos: [...] }
// POST <base>  { action:'sync', todos } -> { ok, synced }   (server LWW by updated_at)
//
// `cacheBust` matters: dooo-api GET responses are cacheable, so a pull right
// after a push can otherwise serve a stale snapshot and revert local edits.
export function createTodoTransport({ baseUrl, getToken }) {
  const token = () => (typeof getToken === "function" ? getToken() : getToken) || "";
  const base = () => (typeof baseUrl === "function" ? baseUrl() : baseUrl) || "";
  return {
    async pull() {
      const url = withQuery(base(), { token: token(), _: Date.now() });
      const resp = await fetch(url, { method: "GET", cache: "no-store" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (!data.ok || !Array.isArray(data.todos)) throw new Error("bad pull response");
      return data.todos;
    },
    async push(records) {
      const resp = await fetch(base(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "sync", token: token(), todos: records }),
      });
      if (!resp.ok) return { ok: false, status: resp.status, error: `HTTP ${resp.status}` };
      return resp.json();
    },
  };
}

// pre-dooo inbox ---------------------------------------------------------------
//
// Capture is append-with-dedup; the engine's dedupeField handles the client side.
// Pull reads the inbox; push replays queued captures through /api/capture (each
// idempotent server-side).
export function createInboxTransport({ baseUrl, getToken, listPath = "/api/inbox", capturePath = "/api/capture" }) {
  const token = () => (typeof getToken === "function" ? getToken() : getToken) || "";
  const auth = () => (token() ? { Authorization: `Bearer ${token()}` } : {});
  return {
    async pull() {
      const url = withQuery(baseUrl + listPath, { status: "all", _: Date.now() });
      const resp = await fetch(url, { method: "GET", cache: "no-store", headers: auth() });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      return Array.isArray(data.items) ? data.items : Array.isArray(data.inbox) ? data.inbox : [];
    },
    async push(records) {
      // Each queued capture is posted independently; a failure aborts the batch
      // so the outbox retains it for the next drain.
      for (const rec of records) {
        const resp = await fetch(baseUrl + capturePath, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...auth() },
          body: JSON.stringify({ text: rec.text ?? rec.transcript, source: rec.source, location: rec.location }),
        });
        if (!resp.ok) return { ok: false, status: resp.status, error: `HTTP ${resp.status}` };
      }
      return { ok: true };
    },
  };
}
