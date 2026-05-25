#!/usr/bin/env node
// One-shot Easypanel service-log tail over WebSocket. Connects to
// wss://<panel>/ws/serviceLogs, streams whatever the panel sends for
// `--duration` seconds (default 30), then exits. Use this when you
// want a service's runtime log from the CLI without opening the UI —
// the tRPC helper (easypanel.mjs) can't drive WebSockets, and the
// OpenAPI spec at /api/openapi.json does NOT list this endpoint, so
// the URL pattern below is empirically verified (panel 2.28.0).
//
// Usage:
//   node easypanel-logs.mjs <project> <service> [--duration=30] [--compose=true|false] [--grep=PATTERN] [--no-history]
//
// Examples:
//   node easypanel-logs.mjs blog web
//   node easypanel-logs.mjs telegram-s3 api --duration=10 --grep='ERROR|WARN'
//   node easypanel-logs.mjs my-stack web --compose=true
//
// Notes:
//   * Project/service are joined as "<project>_<service>" before hitting
//     the panel (Docker stack naming).
//   * On connect the panel sends a backlog of recent log lines, then
//     streams live frames. Pass --no-history to skip everything
//     received in the first 500ms (heuristic — there's no signal in
//     the protocol that says "history ended, live starts here").
//   * Exits 0 on clean disconnect / timeout, 1 on connection error, 2
//     on bad arguments.

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const flags = new Map();
const positional = [];
for (const a of args) {
  if (a.startsWith("--")) {
    const eq = a.indexOf("=");
    if (eq > 0) flags.set(a.slice(2, eq), a.slice(eq + 1));
    else flags.set(a.slice(2), "true");
  } else {
    positional.push(a);
  }
}

const project = positional[0];
const service = positional[1];
if (!project || !service) {
  console.error("usage: easypanel-logs.mjs <project> <service> [--duration=30] [--compose=true|false] [--grep=PATTERN] [--no-history]");
  process.exit(2);
}

const durationMs = Math.max(1, Number(flags.get("duration") ?? 30)) * 1000;
const composeRaw = flags.get("compose") ?? "false";
const compose = composeRaw === "1" || composeRaw === "true" ? "true" : "false";
const grepRe = flags.has("grep") ? new RegExp(flags.get("grep")) : null;
const noHistory = flags.has("no-history");

// Priority: env vars > ~/.easypanel/config.json — same order as easypanel.mjs
// so CI workflows that set EASYPANEL_* see consistent behavior.
let URL_BASE = process.env.EASYPANEL_URL?.replace(/\/$/, "");
let TOKEN = process.env.EASYPANEL_TOKEN;
if (!URL_BASE || !TOKEN) {
  const cfgPath = join(homedir(), ".easypanel", "config.json");
  if (existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
      URL_BASE ??= cfg.url?.replace(/\/$/, "");
      TOKEN ??= cfg.token;
    } catch (err) {
      console.error(`Failed to read ${cfgPath}: ${err.message}`);
      process.exit(2);
    }
  }
}
if (!URL_BASE || !TOKEN) {
  console.error("No Easypanel credentials found.");
  console.error("Set EASYPANEL_URL + EASYPANEL_TOKEN, or run: node bootstrap-token.mjs");
  process.exit(2);
}

const wsUrl = new URL(URL_BASE);
wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
wsUrl.pathname = "/ws/serviceLogs";
wsUrl.searchParams.set("token", TOKEN);
wsUrl.searchParams.set("service", `${project}_${service}`);
wsUrl.searchParams.set("compose", compose);

// Panel certs may be self-signed depending on deploy; mirror easypanel.mjs's
// tolerance so this works against the same infrastructure that helper does.
// Only override if the operator hasn't already pinned the env var.
process.env.NODE_TLS_REJECT_UNAUTHORIZED ??= "0";

const ws = new WebSocket(wsUrl.href);
const connectAt = Date.now();
const HISTORY_CUTOFF_MS = 500; // anything received in the first 500ms is treated as backlog when --no-history is set
let received = 0;

ws.addEventListener("open", () => {
  console.error(`[easypanel-logs] connected; reading for ${durationMs / 1000}s${grepRe ? ` (grep=${grepRe})` : ""}${noHistory ? " (no-history)" : ""}`);
});

ws.addEventListener("message", (ev) => {
  received++;
  if (noHistory && Date.now() - connectAt < HISTORY_CUTOFF_MS) return;

  // The panel wraps each frame as {"output":"<concatenated newline-separated lines>"}.
  // Older docs claimed raw text or {"data":"..."}; cover all three shapes so
  // this keeps working if the envelope changes.
  let text = typeof ev.data === "string" ? ev.data : ev.data?.toString?.("utf8") ?? "";
  try {
    const j = JSON.parse(text);
    if (typeof j === "object" && j !== null) {
      if (typeof j.output === "string") text = j.output;
      else if (typeof j.data === "string") text = j.data;
    }
  } catch {}

  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    if (!grepRe || grepRe.test(line)) console.log(line);
  }
});

ws.addEventListener("error", (e) => {
  console.error("[easypanel-logs] ws error:", e?.message ?? String(e));
  process.exit(1);
});

ws.addEventListener("close", (ev) => {
  console.error(`[easypanel-logs] closed code=${ev.code} reason=${ev.reason || "<none>"}; frames=${received}`);
  process.exit(0);
});

setTimeout(() => {
  console.error(`[easypanel-logs] duration elapsed; closing (frames=${received})`);
  ws.close();
}, durationMs);
