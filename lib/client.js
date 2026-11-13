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
var TN_VERSION = true ? "0.2.2-dev.17" : "unknown";
var FOCUS_HASH_PREFIX = "#dsh-focus=";
var RETRY_MS = 250;
var RETRY_MAX = 60;
var POLL_ERROR_BACKOFF_MS = 2e3;
var isDesktopPage = () => window.location.protocol === "dsh-app:" || "__DSH_LOCALE__" in window;
var NativeNotification = window.Notification;
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
  const showNativeNotify = (e) => {
    if (NativeNotification === void 0) {
      log("Notification API \u4E0D\u53EF\u7528\uFF0C\u8DF3\u8FC7\u539F\u751F\u901A\u77E5 seq=" + e.seq + "\uFF08\u670D\u52A1\u7AEF\u8D85\u65F6\u540E\u5E73\u53F0\u901A\u9053\u515C\u5E95\uFF09");
      return;
    }
    const fire = () => {
      if (NativeNotification === void 0 || NativeNotification.permission !== "granted") {
        log("\u901A\u77E5\u6743\u9650\u672A\u6388\u4E88\uFF0C\u8DF3\u8FC7\u539F\u751F\u901A\u77E5 seq=" + e.seq + "\uFF08\u670D\u52A1\u7AEF\u8D85\u65F6\u540E\u5E73\u53F0\u901A\u9053\u515C\u5E95\uFF09");
        return;
      }
      const title = typeof e.title === "string" && e.title.length > 0 ? e.title : "DSH";
      const body = typeof e.body === "string" ? e.body : "";
      let notification;
      try {
        notification = new NativeNotification(title, { body, silent: e.silent === true });
      } catch (err) {
        log("Notification \u6784\u9020\u5931\u8D25:", String(err));
        return;
      }
      const ack = () => {
        fetch("/turn-notify/notify-ack", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ seq: e.seq })
        }).catch(() => {
        });
      };
      notification.addEventListener("show", ack);
      setTimeout(ack, 400);
      notification.addEventListener("click", () => {
        if (typeof e.sessionId === "string" && e.sessionId.length > 0) focusSession(e.sessionId, "native-notify");
        window.focus();
        fetch("/turn-notify/clicked", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({})
        }).catch(() => {
        });
      });
    };
    if (NativeNotification.permission === "granted") {
      fire();
    } else if (typeof NativeNotification.requestPermission === "function") {
      NativeNotification.requestPermission().then((p) => {
        if (p === "granted") fire();
      }).catch(() => {
      });
    }
  };
  let lastSeq = 0;
  const clientKind = isDesktopPage() ? "desktop:" : "";
  const clientId = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Math.random().toString(36).slice(2);
  const pollTimer = [];
  const poll = async () => {
    if (stopped) return;
    let ok = false;
    try {
      const res = await fetch("/turn-notify/focus-wait?client=" + clientKind + clientId + "&since=" + lastSeq);
      if (res.ok) {
        ok = true;
        const data = await res.json().catch(() => null);
        if (data !== null && Array.isArray(data.entries)) {
          for (const e of data.entries) {
            if (typeof e.seq !== "number" || e.seq <= lastSeq) continue;
            lastSeq = e.seq;
            if (e.kind === "notify") {
              if (clientKind !== "") showNativeNotify(e);
              continue;
            }
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
  log("loaded; client=" + clientKind + clientId);
}

		return module.exports;
	}
});
