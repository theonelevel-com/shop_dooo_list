// auth-ui.js — shared standalone sign-in overlay + magic-link landing for the
// installable PWAs (pre / to / shop). In-shell (iframe) copies get their token
// from the dash bridge and never call this; this is the standalone path.
//
// iOS note: an installed PWA can't receive the emailed *link* (Mail opens
// Safari, a different storage context), so the 6-digit *code* typed here is the
// primary path on phones. The link path still works on desktop.

import { requestMagicLink, verifyMagicLink } from "./auth-client.js";

// If the app was opened from a magic link (?lt=<token>), exchange it for a
// session, persist it, and strip the token from the URL. Returns the session or
// null. Safe to call on every boot.
export async function consumeMagicLinkLanding(apiBase, sessionStore) {
  let url;
  try { url = new URL(location.href); } catch { return null; }
  const lt = url.searchParams.get("lt");
  if (!lt) return null;
  let session = null;
  try {
    const data = await verifyMagicLink(apiBase, { token: lt });
    session = await sessionStore.save(data);
  } catch {
    session = null;
  }
  url.searchParams.delete("lt");
  try { history.replaceState(null, "", url.pathname + (url.search || "") + url.hash); } catch { /* ignore */ }
  return session;
}

// Render a full-screen sign-in overlay. Resolves the returned promise with the
// session once the user completes email → link/code. `redirect` is where the
// emailed link lands (usually location.origin + "/").
export function mountSignIn({ apiBase, redirect, sessionStore, appName = "dooo" }) {
  return new Promise((resolve) => {
    injectStyles();
    const host = document.createElement("div");
    host.className = "dooo-signin";
    host.innerHTML = `
      <div class="dooo-signin-card">
        <div class="dooo-signin-brand">${escapeHtml(appName)}</div>
        <form class="dooo-signin-email">
          <p>Sign in with your email — we'll send a link and a code.</p>
          <input type="email" inputmode="email" placeholder="you@example.com" required />
          <button type="submit">Send link</button>
        </form>
        <form class="dooo-signin-code" hidden>
          <p>Check <b class="dooo-signin-to"></b>. Click the link, or enter the 6-digit code:</p>
          <input type="text" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="123456" />
          <button type="submit">Verify</button>
          <button type="button" class="dooo-signin-back">Use a different email</button>
        </form>
        <p class="dooo-signin-status"></p>
        <p class="dooo-signin-home"><a href="https://www.dooolist.com">← dooolist.com</a></p>
      </div>`;
    document.body.appendChild(host);

    const emailForm = host.querySelector(".dooo-signin-email");
    const codeForm = host.querySelector(".dooo-signin-code");
    const emailInput = emailForm.querySelector("input");
    const codeInput = codeForm.querySelector("input");
    const status = host.querySelector(".dooo-signin-status");
    let email = "";

    emailForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      email = emailInput.value.trim();
      if (!email) return;
      status.textContent = "Sending…";
      try {
        await requestMagicLink(apiBase, { email, redirect });
        status.textContent = "";
        emailForm.hidden = true;
        codeForm.hidden = false;
        host.querySelector(".dooo-signin-to").textContent = email;
        codeInput.focus();
      } catch {
        status.textContent = "Couldn't reach the server. Try again.";
      }
    });

    codeForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const code = codeInput.value.trim();
      if (!code) return;
      status.textContent = "Checking…";
      try {
        const data = await verifyMagicLink(apiBase, { email, code });
        const session = await sessionStore.save(data);
        host.remove();
        resolve(session);
      } catch (err) {
        status.textContent = err?.status === 429 ? "Too many tries — request a new link." : "Incorrect code.";
      }
    });

    host.querySelector(".dooo-signin-back").addEventListener("click", () => {
      codeForm.hidden = true;
      emailForm.hidden = false;
      status.textContent = "";
    });
  });
}

function injectStyles() {
  if (document.getElementById("dooo-signin-styles")) return;
  const s = document.createElement("style");
  s.id = "dooo-signin-styles";
  s.textContent = `
    .dooo-signin{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;
      justify-content:center;background:#0f1419;padding:24px;font-family:system-ui,-apple-system,sans-serif}
    .dooo-signin-card{width:100%;max-width:360px;background:#171e26;border:1px solid #263040;
      border-radius:12px;padding:28px 24px;color:#e6edf3}
    .dooo-signin-brand{text-align:center;font-weight:700;font-size:18px;margin-bottom:16px}
    .dooo-signin p{margin:0 0 12px;color:#9fb0c0;font-size:14px;line-height:1.5}
    .dooo-signin input{width:100%;box-sizing:border-box;margin:0 0 12px;padding:10px 12px;
      background:#0f1419;border:1px solid #263040;border-radius:8px;color:#e6edf3;font-size:15px}
    .dooo-signin-code input{letter-spacing:6px;text-align:center;font-size:20px}
    .dooo-signin button{width:100%;padding:10px;border:0;border-radius:8px;background:#5b8def;
      color:#fff;font-weight:600;font-size:15px;cursor:pointer;margin-bottom:8px}
    .dooo-signin-back{background:#263040 !important}
    .dooo-signin-status{min-height:1em;color:#f0a0a0;font-size:13px;margin:8px 0 0 !important}
    .dooo-signin-home{text-align:center;margin:20px 0 0 !important}
    .dooo-signin-home a{color:#7a8ba0;font-size:13px;text-decoration:none}`;
  document.head.appendChild(s);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
