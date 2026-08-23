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
var inject = ["sessions", "remote"];
var FOCUS_HASH_PREFIX = "#dsh-focus=";
var HEARTBEAT_MS = 5e3;
function apply(ctx) {
  const log = (...a) => console.log("[turn-notify/client]", ...a);
  const sessions = ctx.sessions;
  const remote = ctx.remote;
  const focusSession = (sessionId, from) => {
    try {
      sessions.open(sessionId);
      window.focus();
      log("focused session", sessionId, "via", from);
    } catch (err) {
      log("open failed (session not in list?):", sessionId, String(err));
    }
  };
  ctx.effect(() => {
    const dispose = remote.$on("turn-notify/focus", ({ sessionId }) => {
      focusSession(sessionId, "host-event");
    });
    return dispose;
  }, "turn-notify-client: focus subscription");
  const beat = () => {
    fetch("/turn-notify/presence", { method: "POST", keepalive: true }).catch(() => {
    });
  };
  beat();
  const timer = setInterval(beat, HEARTBEAT_MS);
  ctx.effect(() => () => clearInterval(timer), "turn-notify-client: heartbeat");
  const applyDeepLink = () => {
    const hash = window.location.hash;
    if (!hash.startsWith(FOCUS_HASH_PREFIX)) return;
    const sessionId = decodeURIComponent(hash.slice(FOCUS_HASH_PREFIX.length));
    history.replaceState(null, "", window.location.pathname + window.location.search);
    if (sessionId.length > 0) {
      focusSession(sessionId, "deep-link");
      channel?.postMessage({ type: "focus", sessionId });
    }
  };
  const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("dsh-turn-notify") : void 0;
  let isLeader = true;
  if (channel !== void 0) {
    channel.onmessage = (ev) => {
      const data = ev.data;
      if (data.type === "leader-claim") {
        isLeader = false;
      } else if (data.type === "focus" && typeof data.sessionId === "string") {
        if (isLeader) focusSession(data.sessionId, "broadcast");
      }
    };
    channel.postMessage({ type: "leader-claim" });
    ctx.effect(() => () => channel.close(), "turn-notify-client: channel");
  }
  applyDeepLink();
  document.title = (document.title || "DSH") + " \u2014 DSH";
  log("loaded; leader=" + isLeader);
}

		return module.exports;
	}
});
