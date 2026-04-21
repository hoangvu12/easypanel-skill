#!/usr/bin/env node
// Thin Easypanel tRPC client. Usage:
//   node easypanel.mjs <procedure> [json-input] [--query|--mutation]
//   node easypanel.mjs <procedure> --file <path>     # read JSON from file
//   node easypanel.mjs <procedure> --stdin           # read JSON from stdin
//   node easypanel.mjs <procedure> key=value ...     # key=value pairs (values parsed as JSON when possible)
//
// Env:
//   EASYPANEL_URL   e.g. https://panel.example.com
//   EASYPANEL_TOKEN permanent API token or session token

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Priority: env vars > ~/.easypanel/config.json
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
  console.error("Set EASYPANEL_URL + EASYPANEL_TOKEN, or run: node scripts/bootstrap-token.mjs");
  process.exit(2);
}

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const positional = args.filter((a) => !a.startsWith("--"));
const [procedure, ...restPositionals] = positional;

if (!procedure) {
  console.error("Usage: easypanel.mjs <procedure> [json-input|--file <path>|--stdin|key=value ...] [--query|--mutation]");
  process.exit(2);
}

let input;

// 1. --file flag: read JSON from file
const fileFlagIndex = args.indexOf("--file");
if (fileFlagIndex !== -1 && args[fileFlagIndex + 1]) {
  const filePath = args[fileFlagIndex + 1];
  try {
    input = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (e) {
    console.error(`Failed to read/parse JSON from file ${filePath}: ${e.message}`);
    process.exit(2);
  }
}
// 2. --stdin flag: read JSON from stdin
else if (flags.has("--stdin")) {
  try {
    const stdinBuffer = readFileSync(0, "utf8"); // 0 = stdin
    input = JSON.parse(stdinBuffer);
  } catch (e) {
    console.error(`Failed to read/parse JSON from stdin: ${e.message}`);
    process.exit(2);
  }
}
// 3. key=value pairs: build object from positional args
else if (restPositionals.length > 0 && restPositionals.every((a) => a.includes("="))) {
  input = {};
  for (const pair of restPositionals) {
    const [key, ...valueParts] = pair.split("=");
    const valueStr = valueParts.join("="); // handle values with = in them
    try {
      input[key] = JSON.parse(valueStr);
    } catch {
      input[key] = valueStr; // fallback to string
    }
  }
}
// 4. Single raw JSON arg (fallback for bash users)
else if (restPositionals.length === 1) {
  const rawInput = restPositionals[0];
  try {
    input = JSON.parse(rawInput);
  } catch (e) {
    console.error(`Invalid JSON input: ${e.message}`);
    console.error(`Input received: ${rawInput}`);
    process.exit(2);
  }
}

// Heuristic: procedures starting with these verbs are queries; everything else is a mutation.
// Override with --query / --mutation.
const QUERY_PREFIXES = [
  "list", "inspect", "get", "stats", "status", "fetch", "read", "show",
];
function isQuery(proc) {
  if (flags.has("--query")) return true;
  if (flags.has("--mutation")) return false;
  const tail = proc.split(".").pop() ?? "";
  return QUERY_PREFIXES.some((p) => tail.startsWith(p));
}

const url = `${URL_BASE}/api/trpc/${procedure}`;
const headers = {
  "Authorization": `Bearer ${TOKEN}`,
  "Content-Type": "application/json",
};

let res;
if (isQuery(procedure)) {
  const qs = input === undefined
    ? ""
    : `?input=${encodeURIComponent(JSON.stringify({ json: input }))}`;
  res = await fetch(url + qs, { headers });
} else {
  res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ json: input ?? null }),
  });
}

const text = await res.text();
let body;
try { body = JSON.parse(text); } catch { body = text; }

if (!res.ok) {
  console.error(`HTTP ${res.status} ${res.statusText}`);
  console.error(JSON.stringify(body, null, 2));
  process.exit(1);
}

// Unwrap tRPC envelope: { result: { data: { json: ... } } }
// `json` can legitimately be null for void mutations, so use property-presence check.
let unwrapped = body;
if (body?.result?.data && typeof body.result.data === "object" && "json" in body.result.data) {
  unwrapped = body.result.data.json;
} else if (body?.result?.data !== undefined) {
  unwrapped = body.result.data;
}
console.log(JSON.stringify(unwrapped, null, 2));
