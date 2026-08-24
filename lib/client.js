window.__ModuleLoader__.load({
	id: "dsh-turn-notify",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.ts
var index_exports = {};
__export(index_exports, {
  FOCUS_HASH_PREFIX: () => FOCUS_HASH_PREFIX,
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);
var inject = ["sessions"];
var TN_VERSION = true ? "0.2.2-dev.11" : "unknown";
var FOCUS_HASH_PREFIX = "#dsh-focus=";
var RETRY_MS = 250;
var RETRY_MAX = 60;
var POLL_ERROR_BACKOFF_MS = 2e3;
function apply(ctx) {
  const log = (...a) => console.log("[turn-notify/client v" + TN_VERSION + "]", ...a);
  const sessions = ctx.sessions;
  let stopped = false;
  const focusSession = (sessionId, from) => {
    let attempts = 0;
    const attempt = () => {
      if (stopped) return;
      try {
        sessions.open(sessionId);
        window.focus();
        log("focused session", sessionId, "via", from);
      } catch (err) {
        if (++attempts < RETRY_MAX) {
          setTimeout(attempt, RETRY_MS);
        } else {
          log("open failed after retries (session unknown):", sessionId, String(err));
        }
      }
    };
    attempt();
  };
  let lastSeq = 0;
  const clientId = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Math.random().toString(36).slice(2);
  const pollTimer = [];
  const poll = async () => {
    if (stopped) return;
    let ok = false;
    try {
      const res = await fetch("/turn-notify/focus-wait?client=" + clientId + "&since=" + lastSeq);
      if (res.ok) {
        ok = true;
        const data = await res.json().catch(() => null);
        if (data !== null && Array.isArray(data.entries)) {
          for (const e of data.entries) {
            if (typeof e.seq !== "number" || e.seq <= lastSeq) continue;
            lastSeq = e.seq;
            if (typeof e.sessionId === "string" && e.sessionId.length > 0) focusSession(e.sessionId, "focus-wait");
          }
        }
      }
    } catch {
    }
    if (stopped) return;
    if (ok) {
      void poll();
      return;
    }
    const timer = setTimeout(poll, POLL_ERROR_BACKOFF_MS);
    pollTimer.push(timer);
  };
  void poll();
  ctx.effect(() => () => {
    stopped = true;
    for (const t of pollTimer) clearTimeout(t);
  }, "turn-notify-client: focus poll");
  const hash = window.location.hash;
  if (typeof hash === "string" && hash.startsWith(FOCUS_HASH_PREFIX)) {
    const sessionId = decodeURIComponent(hash.slice(FOCUS_HASH_PREFIX.length));
    history.replaceState(null, "", window.location.pathname + window.location.search);
    if (sessionId.length > 0) {
      focusSession(sessionId, "deep-link");
      fetch("/turn-notify/focus", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId })
      }).catch(() => {
      });
    }
  }
  if (!(document.title || "").includes(" \u2014 DSH")) {
    document.title = (document.title || "DSH") + " \u2014 DSH";
  }
  log("loaded; client=" + clientId);
}

		return module.exports;
	}
});
