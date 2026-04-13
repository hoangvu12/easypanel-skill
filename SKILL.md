---
name: easypanel
description: Manage Easypanel servers via the undocumented tRPC API at /api/trpc. Use when the user wants to list/create/deploy/inspect projects, app services, databases (postgres/mysql/mongo/redis), docker compose stacks, domains, ports, env vars, or check system stats on an Easypanel instance.
---

# Easypanel skill

Talks to an Easypanel server through its tRPC API. No official REST docs exist — the API is undocumented but stable.

## Setup (one-time per instance)

Credentials are read in this order:
1. Env vars `EASYPANEL_URL` + `EASYPANEL_TOKEN` (useful for CI)
2. `~/.easypanel/config.json` — `{ "url": "...", "token": "..." }` (mode 0600)

**First-run flow — if neither is set, run the bootstrap script:**
```bash
node scripts/bootstrap-token.mjs
```
It prompts for URL / email / password (+ optional 2FA), walks the tRPC auth flow
(`auth.login` → `users.listUsers` → `users.generateApiToken`), and writes a permanent
token to `~/.easypanel/config.json`. Pass `--force` to overwrite an existing config.

**If the user invokes this skill and has no config yet:** run the bootstrap script for
them and walk them through the prompts. Never ask them to paste the token into chat —
the script captures password input with echo suppressed and writes directly to disk.

## Calling procedures

Use the helper `scripts/easypanel.mjs`:

```bash
node scripts/easypanel.mjs <procedure> '<json-input>'
# e.g.
node scripts/easypanel.mjs projects.listProjects
node scripts/easypanel.mjs projects.createProject '{"name":"blog"}'
node scripts/easypanel.mjs services.app.deploy '{"projectName":"blog","serviceName":"web"}'
```

tRPC quirks:
- **Queries** (list/inspect/stats) → GET with input as `?input=<url-encoded-json>`
- **Mutations** (create/deploy/destroy/set*) → POST with body `{"json": <input>}`
- The helper handles both automatically based on a hardcoded list; if a procedure is missing, pass `--mutation` or `--query` explicitly.
- Responses unwrap `result.data.json` for you.

## Procedure reference (verified)

**Projects**
- `projects.listProjects` (query)
- `projects.inspectProject` (query) — `{projectName}`
- `projects.createProject` (mutation) — `{name}`
- `projects.destroyProject` (mutation) — `{projectName}`

**App services** (namespace: `services.app.*`)
- `.create` — `{projectName, serviceName}`
- `.inspect` (query) — `{projectName, serviceName}`
- `.deploy`, `.start`, `.stop`, `.restart`, `.destroy` — `{projectName, serviceName}`
- `.setSourceImage` — `{projectName, serviceName, image}`
- `.setSourceGithub` — `{projectName, serviceName, owner, repo, ref, path?}`
- `.setEnv` — `{projectName, serviceName, env}` (env is a `KEY=VALUE` newline string)
- `.setResources` — `{projectName, serviceName, memoryLimit, memoryReservation, cpuLimit, cpuReservation}`

**Databases** — `services.{postgres,mysql,mongo,redis}.{create,inspect,destroy}`
- Create shape: `{projectName, serviceName, password?, image?}`

**Compose** — `services.compose.{create,inspect,deploy}`

**Domains / ports**
- `domains.listDomains`, `.createDomain`, `.deleteDomain`
- `ports.listPorts`, `.createPort`

**System / monitoring** (namespace is `monitor.*`, not `system.*`)
- `monitor.getSystemStats` (query) — current uptime, cpuInfo, load
- `monitor.getAdvancedStats` (query) — historical cpu/memory arrays
- `system.cleanup`, `system.prune`, `system.restart`, `system.reboot` (mutations — names unverified, probe first)

**Users**
- `users.listUsers` (query), `users.generateApiToken`, `users.revokeApiToken`

There are ~347 total procedures. For anything not listed, try it via the helper — the server returns descriptive Zod validation errors that reveal the expected input shape.

## Safety

- `destroy*`, `prune`, `reboot`, `restart`, `cleanup` are **destructive and affect shared infra**. Always confirm with the user before calling them, even if they previously approved a similar action. Never chain a destroy with anything else.
- Never log the token. When showing example curl commands, reference `$EASYPANEL_TOKEN` rather than pasting it.
- Prefer `projects.inspectProject` before mutating. It returns the full project **including all nested services, their source config, env, domains, and deploy history** — so you usually don't need a separate `services.app.inspect` call. Use it to diff current state before any mutation.

## Typical flows

**Deploy a new app from GitHub:**
1. `projects.createProject` (skip if exists — check with `listProjects` first)
2. `services.app.create`
3. `services.app.setSourceGithub`
4. `services.app.setEnv` (if needed)
5. `services.app.deploy`
6. `domains.createDomain` for the public URL

**Check why a service is down:**
1. `services.app.inspect` — look at status + last deploy
2. `system.stats` + `services.stats` — CPU/memory pressure
3. Report findings; ask before restarting
