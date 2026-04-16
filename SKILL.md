---
name: easypanel
description: Manage Easypanel servers via the undocumented tRPC API at /api/trpc. Use when the user wants to list/create/deploy/inspect projects, app services, databases (postgres/mysql/mongo/redis/mariadb), docker compose stacks, domains, ports, env vars, or check system stats on an Easypanel instance.
---

# Easypanel skill

Talks to an Easypanel server through its tRPC API. Easypanel calls it "undocumented but supported" — no official OpenAPI/docs page (`/docs/api` on easypanel.io 404s). Two third-party references:

- https://samleinav.github.io/Easypanel-Api/ — hand-written docs for a subset of procedures. Accurate but incomplete (misses many real procedures).
- https://github.com/Easypanel-Community/easypanel `src/utils/routes.ts` — 2023 TS SDK route map. **Stale in spots** — several listed paths 404 on current Easypanel (`enableService`, `disableService`, `exposeService`, `updatePorts`, `updateMounts`, `updateBackup`, `updateDomains`, `logs.getServiceLogs`, `settings.pruneDockerImages`, Traefik config).

Every procedure path below was either verified against a live panel (Zod error = path+shape exist, or a successful call) or explicitly flagged as unverified.

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
node scripts/easypanel.mjs services.app.deployService '{"projectName":"blog","serviceName":"web"}'
```

tRPC quirks:
- **Queries** → GET with `?input=<url-encoded-json>`; **mutations** → POST with body `{"json": <input>}`.
- The helper picks GET vs POST from a prefix heuristic on the last path segment (`list`, `inspect`, `get`, `stats`, `status`, `fetch`, `read`, `show`, `can` → query). If a procedure misroutes, pass `--mutation` or `--query` explicitly. (`canCreateProject` is a query and needed `--query` with this heuristic.)
- Responses unwrap `result.data.json` for you. Void mutations return `null` on success — that's the "worked" signal.
- Errors: **404 `NOT_FOUND`** = wrong path; **500 with Zod-array message** = path exists, fix the input; **405 `METHOD_NOT_SUPPORTED`** = right path, wrong verb (try `--query`).

## ⚠️ Dangerous partial-input behavior on `update*` mutations

**`services.<type>.update*` mutations REPLACE the field wholesale. Omitting an optional sub-field does not leave it unchanged — it sets it to null/empty.**

Real example: calling `services.app.updateEnv '{"projectName":"x","serviceName":"y"}'` (to probe the shape) **wiped the service's env vars** because `env` is optional and defaulted to empty. Same for `updateBuild`, `updateResources`, `updateRedirects`, `updateDeploy`, `updateMaintenance`, `updateBasicAuth`.

Rules:
1. **Never pass a real `{projectName, serviceName}` to an unknown mutation just to probe its shape.** Probe with `{}` only — you'll get a Zod error naming the first missing field (usually `projectName`), confirming the path exists without mutating anything.
2. **Before any `update*` call, `inspectService` first** and build the full config (existing values + your changes), then send. Do not send just the field you want to change.
3. If you do wipe something by accident: `inspectService` won't help (it shows the post-wipe state). You need the source of truth (repo `.env`, another sibling service with the same config, etc.) to reconstruct it.

## Procedure reference (verified live)

### Projects (`projects.*`)
- `listProjects` (query, no input)
- `listProjectsAndServices` (query, no input) — preferred for bulk inspection
- `canCreateProject` (query, no input) — returns `true`/`false`. **Is a query despite the verb.**
- `inspectProject` (query) — `{projectName}` — returns the project incl. all nested services, source, env, build, commit history
- `createProject` (mutation) — `{name}`
- `destroyProject` (mutation) — **`{name}`** (NOT `{projectName}` — verified via Zod)

### App services (`services.app.*`) — every service type shares the same method set: `services.{app,postgres,mysql,mongo,redis,mariadb,compose}.*`

Lifecycle (mutations, `{projectName, serviceName}`):
- `createService`, `inspectService` (query), `destroyService`
- `deployService`
- `startService`, `stopService`, `restartService` — **these replaced the 2023 `enableService`/`disableService`/`exposeService` which now 404**
- `refreshDeployToken` — rotates per-service deploy webhook token

Source config (mutations, all on top of `{projectName, serviceName}`):
- `updateSourceGithub` — `+ {owner, repo, ref, path}` (autoDeploy seen in responses but not required by Zod)
- `updateSourceGit` — `+ {repo, ref, path}` (note: field is `repo`, not `repository` as the 2023 SDK claimed)
- `updateSourceImage` — `+ {image, username?, password?}`
- `updateSourceDockerfile` — `+ {dockerfile}` (inline contents)

Service config (mutations, `{projectName, serviceName, ...}`) — **all wipe-on-omit; see warning above**:
- `updateEnv` — `+ {env}` (newline-separated `KEY=VALUE` string; `\n` works, responses come back with `\r\n`)
- `updateBuild` — `+ {build: {type, ...}}` — type is one of `"nixpacks"`, `"dockerfile"`, etc. Nixpacks: `{type:"nixpacks", nixpacksVersion:"1.34.1"}`. Dockerfile: `{type:"dockerfile", file:"Dockerfile"}`.
- `updateResources` — `+ {resources: {memoryReservation, memoryLimit, cpuReservation, cpuLimit}}` (all numbers; nested per samleinav docs — flat form was not verified)
- `updateRedirects`, `updateBasicAuth`, `updateDeploy`, `updateMaintenance` — shapes not fully probed; inspect first
- mariadb-only: `updateAdvanced`

Confirmed 404 on current Easypanel (don't try these):
`enableService`, `disableService`, `exposeService`, `updatePorts`, `updateMounts`, `updateBackup`, `updateDomains`

Redis-specific extras (`services.redis.*`): `updateCredentials`, `enableDbGate`, `disableDbGate`, `enableRedisCommander`, `disableRedisCommander`.

### Monitor (`monitor.*`, all queries)
- `getSystemStats` — host uptime, cpuInfo, load, memory, network
- `getAdvancedStats` — historical time-series arrays (cpu/memory at intervals)
- `getServiceStats` — `{projectName, serviceName, serviceType}` where serviceType is the namespace (`"app"`, `"postgres"`, etc.); returns live CPU/memory/network for one service
- `getDockerTaskStats` — per-task actual vs desired replicas
- `getMonitorTableData` — all containers, including foreign ones

### Auth / users
- `auth.login` (mutation) — `{email, password}`
- `auth.logout` (mutation)
- `auth.getSession` (query) — **not `auth.getUser`** (SDK is wrong); returns `{id, userId, expiresAt, demoMode, ...}`
- `users.listUsers` (query)
- `users.generateApiToken`, `users.revokeApiToken` (mutations)

### Settings (`settings.*`) — many destructive; confirm before calling
- Server: `restartEasypanel`, `getServerIp` (query), `refreshServerIp`
- Panel: `getPanelDomain` (query), `setPanelDomain`
- TLS: `getLetsEncryptEmail` (query), `setLetsEncryptEmail`
- GitHub: `getGithubToken` (query), `setGithubToken`
- Creds: `changeCredentials`

Confirmed 404: `getTraefikCustomConfig`, `updateTraefikCustomConfig`, `restartTraefik`, `pruneDockerImages`, `pruneDockerBuilder`, `setPruneDockerDaily` — all listed in the 2023 SDK, all removed/renamed. Probe before documenting replacements.

### Templates
- `templates.createFromSchema` (mutation) — `{projectName, schema: {services: [...]}}` — bulk deploy a stack

### Logs (WebSocket, not tRPC)
Per samleinav docs:
- `wss://<panel>/serviceLogs?token=<token>&service=<projectName>_<serviceName>&compose=<0|1>`

Not REST — the 2023 SDK's `logs.getServiceLogs` doesn't exist on current panels. The tRPC helper can't drive this; use a WebSocket client separately.

### Code upload (REST, not tRPC)
- `POST /api/upload-code/{projectName}/{serviceName}` with multipart `file=<zip>` for deploy-without-git flows.

## Safety

- Destructive/infra procedures: `destroy*`, `restartEasypanel`, `refreshServerIp`, `refreshDeployToken`, `changeCredentials`, `stopService`, `restartService`. **Always confirm with the user, even if they previously approved a similar action.** Never chain a destroy with anything else.
- **All `update*` mutations are effectively destructive** to whatever field they touch — re-read the warning block above. `inspectService` → build full payload → `update*`. Do not send minimal diffs.
- Probing: to verify a procedure path exists, send `{}` — the Zod error confirms the path. **Do not send a real `{projectName, serviceName}`** to an `update*` mutation you haven't verified the shape of — the Zod validator passes through optional fields and the mutation applies.
- Never log the token. Reference `$EASYPANEL_TOKEN` in examples.

## Typical flows

**Redeploy an existing service (latest from tracked branch):**
```bash
node scripts/easypanel.mjs services.app.deployService '{"projectName":"X","serviceName":"Y"}'
# Verify:
node scripts/easypanel.mjs services.app.inspectService '{"projectName":"X","serviceName":"Y"}'
# → commit.sha should be the branch HEAD
```

**Deploy a new app from GitHub:**
1. `projects.listProjectsAndServices` — check if exists
2. `projects.createProject` if needed — `{name}`
3. `services.app.createService` — `{projectName, serviceName}`
4. `services.app.updateSourceGithub` — `{projectName, serviceName, owner, repo, ref, path}`
5. `services.app.updateEnv` if needed — **send the FULL env block, not a diff**
6. `services.app.deployService`

**Check why a service is down:**
1. `services.app.inspectService` — look at the `deploy` log + `enabled` flag
2. `monitor.getServiceStats` with `serviceType: "app"` — live CPU/memory
3. For container logs, use the WebSocket endpoint (see Logs section)
4. Report findings; ask before restarting or redeploying

**Update a single env var without wiping the others:**
1. `services.app.inspectService` → read `env` (a newline-separated string)
2. Parse it in your script, modify the one line
3. `services.app.updateEnv` with the **full rebuilt string**
