#!/usr/bin/env node
// Interactive Easypanel token bootstrap.
// Prompts for URL/email/password (+optional 2FA), walks the tRPC auth flow,
// and writes ~/.easypanel/config.json with mode 0600.
//
// Usage: node bootstrap-token.mjs
//        node bootstrap-token.mjs --force   (overwrite existing config)

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import readline from "node:readline";

const CONFIG_DIR = join(homedir(), ".easypanel");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const FORCE = process.argv.includes("--force");

if (existsSync(CONFIG_PATH) && !FORCE) {
  const current = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  console.error(`Config already exists at ${CONFIG_PATH} (url: ${current.url}).`);
  console.error("Pass --force to overwrite.");
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
const ask = (q) => new Promise((r) => rl.question(q, r));

// Hidden input for passwords — mutes stdout echo during typing.
function askHidden(q) {
  return new Promise((resolve) => {
    process.stderr.write(q);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let buf = "";
    const onData = (ch) => {
      if (ch === "\r" || ch === "\n" || ch === "\u0004") {
        stdin.setRawMode?.(wasRaw ?? false);
        stdin.pause();
        stdin.removeListener("data", onData);
        process.stderr.write("\n");
        resolve(buf);
      } else if (ch === "\u0003") {
        process.exit(130);
      } else if (ch === "\u007f" || ch === "\b") {
        buf = buf.slice(0, -1);
      } else {
        buf += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function trpc(url, procedure, { input, token, method = "POST" } = {}) {
  const endpoint = `${url}/api/trpc/${procedure}`;
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  if (method === "GET") {
    const qs = input === undefined
      ? ""
      : `?input=${encodeURIComponent(JSON.stringify({ json: input }))}`;
    res = await fetch(endpoint + qs, { headers });
  } else {
    res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ json: input ?? null }),
    });
  }
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) {
    const msg = body?.error?.json?.message ?? body?.error?.message ?? text;
    throw new Error(`${procedure} failed (HTTP ${res.status}): ${msg}`);
  }
  return body?.result?.data?.json ?? body?.result?.data ?? body;
}

try {
  const urlRaw = (await ask("Easypanel URL (e.g. https://panel.example.com): ")).trim();
  const url = urlRaw.replace(/\/$/, "");
  const email = (await ask("Email: ")).trim();
  const password = await askHidden("Password: ");
  const code = (await ask("2FA code (press enter to skip): ")).trim();
  rl.close();

  console.error("\n[1/3] Logging in...");
  const loginInput = { email, password };
  if (code) loginInput.code = code;
  const loginResult = await trpc(url, "auth.login", { input: loginInput });
  const sessionToken = loginResult?.token ?? loginResult?.sessionToken;
  if (!sessionToken) {
    throw new Error(`auth.login returned no token. Payload: ${JSON.stringify(loginResult)}`);
  }

  console.error("[2/3] Looking up your user id...");
  const users = await trpc(url, "users.listUsers", { token: sessionToken, method: "GET" });
  const list = Array.isArray(users) ? users : users?.users ?? [];
  const me = list.find((u) => u.email === email) ?? list[0];
  if (!me?.id) {
    throw new Error(`Could not find user. Payload: ${JSON.stringify(users)}`);
  }

  console.error("[3/3] Generating permanent API token...");
  let apiToken;
  try {
    const gen = await trpc(url, "users.generateApiToken", {
      token: sessionToken,
      input: { id: me.id },
    });
    apiToken = gen?.token ?? gen?.apiToken ?? (typeof gen === "string" ? gen : undefined);
  } catch (err) {
    console.error(`  generate call errored (${err.message}); falling back to users.listUsers read...`);
  }
  if (!apiToken) {
    const refreshed = await trpc(url, "users.listUsers", { token: sessionToken, method: "GET" });
    const refreshedList = Array.isArray(refreshed) ? refreshed : refreshed?.users ?? [];
    apiToken = refreshedList.find((u) => u.id === me.id)?.apiToken;
  }
  if (!apiToken) {
    throw new Error("Could not obtain a permanent API token.");
  }

  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify({ url, token: apiToken }, null, 2));
  try { chmodSync(CONFIG_PATH, 0o600); } catch { /* best effort on Windows */ }

  console.error(`\nSaved to ${CONFIG_PATH}`);
  console.error("You can now run easypanel.mjs without any env vars.");
} catch (err) {
  rl.close();
  console.error(`\nBootstrap failed: ${err.message}`);
  process.exit(1);
}
