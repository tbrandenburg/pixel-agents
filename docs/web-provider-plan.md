# Web (REST) Provider — Implementation Plan

Status: **planned, not implemented**
Branch: `feat/web-provider`
Goal: add a second `HookProvider` (`id: 'web'`) that is driven purely by HTTP requests, so an
agent character can be created and animated with `curl` — no CLI, no transcript file, no terminal.

This doubles as the project's first proof that the provider abstraction actually supports a
non-Claude backend, and it is written to be **upstreamable** rather than fork-local.

---

## 1. Motivation

Two things fall out of a REST-driven provider:

1. **Any tool can drive the office.** A CI job, a shell script, a bot, or a non-Claude agent
   framework can render itself as a character by POSTing lifecycle events. No hook installation,
   no transcript format to reverse-engineer.
2. **The provider abstraction gets validated.** `core/src/provider.ts` says provider-type taxonomy
   work is deferred until *"a real second provider ... actually lands, derived from that provider's
   needs rather than speculation."* This is that provider, and it exercises the abstraction at its
   thinnest: no file fallback, no team, no terminal.

Non-goal: replacing or degrading the Claude provider. Both must work simultaneously.

---

## 2. Blocking finding: `providerId` is plumbed but ignored

Before any provider work, this has to be resolved. The current runtime is **single-provider**,
despite the URL shape and docs implying otherwise:

| Location | Current state |
| --- | --- |
| `server/src/httpServer.ts:112` | Route `POST /api/hooks/:providerId` — `providerId` captured and validated (`^[a-z0-9-]+$`) |
| `server/src/agentRuntime.ts:291` | `handleHookEvent(providerId, event)` — forwards it |
| `server/src/hookEventHandler.ts:132` | `handleEvent(_providerId, event)` — **underscore-prefixed, never read** |
| `server/src/cli.ts:118` | `new AgentRuntime(store, claudeProvider)` — provider hard-coded |
| `adapters/vscode/PixelAgentsViewProvider.ts:167` | `new AgentRuntime(this.store, claudeProvider)` — provider hard-coded |
| `server/src/providers/index.ts` | Plain re-export file; nothing consumes it as a lookup table |
| `server/src/clientMessageHandler.ts:229-230` | Reads `claudeProvider.readingTools` / `.subagentToolNames` directly |

Consequence: `POST /api/hooks/web` and `POST /api/hooks/claude` today route to the *same*
provider instance. Adding a provider directory plus an export line is **not** sufficient.

Encouraging counter-signal: `SessionRouter` already stores `providerId` on buffered events
(`server/src/sessionRouter.ts:13`) and replays it (`hookEventHandler.ts:116-117`), so the
buffer/flush path is already provider-aware. The design anticipated this; only the resolution
step is missing.

---

## 3. Phased plan

### Phase 1 — Make `providerId` meaningful (the only invasive phase)

Framed as a fix ("providerId was accepted but ignored"), not a redesign.

- Add a real registry in `server/src/providers/index.ts`: a `Map<string, HookProvider>` plus
  `getProvider(id)` with a documented default, keeping the existing named exports intact so no
  current importer breaks.
- `AgentRuntime` takes the registry (or a resolver) instead of one `HookProvider`, retaining a
  default so existing construction sites and the server test suites keep compiling.
- `HookEventHandler` resolves the provider **per event** from `providerId` instead of the
  constructor-captured `this.provider`.

Two details in `HookEventHandler` that assume a singleton and must move:

- `protocolVersion` check currently runs **once in the constructor** (`hookEventHandler.ts:71-78`)
  and gates dispatch at line 133. With per-event providers this becomes a per-provider check —
  cache the verdict per provider id so an unsupported provider still logs exactly once.
- `getSubagentToolSet()` (`hookEventHandler.ts:82-90`) derives from `this.provider.team` /
  `this.provider.subagentToolNames` — must take the resolved provider as input.

Acceptance: a test proves `/api/hooks/claude` and `/api/hooks/web` reach *different* providers.
All 13 existing server suites stay green with no behavioural change for Claude.

### Phase 2 — The web provider

New isolated directory `server/src/providers/hook/web/` (mirrors `hook/claude/`, cannot conflict
with upstream since it does not exist there):

- `web.ts` — the `HookProvider`. Implements **only** the required surface:
  - `kind: 'hook'`, `id: 'web'`, `displayName`, `protocolVersion: 1`
  - `normalizeHookEvent(raw)` — validates and maps the wire payload onto `AgentEvent`. Payload is
    designed to be near 1:1 with the `AgentEvent` union so normalization stays trivial and the
    API is self-describing.
  - `installHooks` / `uninstallHooks` → no-ops; `areHooksInstalled` → `true`. There is nothing to
    install into: the HTTP call *is* the hook.
  - `formatToolStatus`, `permissionExemptTools`, `subagentToolNames`, `readingTools` — small
    static config over a caller-defined tool vocabulary.
  - Deliberately **omits** every optional member: no `getSessionDirs`, `getAllSessionRoots`,
    `sessionFilePattern`, `parseTranscriptLine`, `buildLaunchCommand`, `terminalNamePrefix`,
    no `team`.
- `constants.ts` — event-name vocabulary and defaults.

Proposed wire shape (to be finalised during implementation):

```jsonc
POST /api/hooks/web
{
  "session_id": "demo-1",          // required; the routing key
  "hook_event_name": "toolStart",  // maps to AgentEvent.kind
  "cwd": "/path/to/project",       // required on sessionStart (see Phase 3)
  "tool_id": "t1",                 // toolStart / toolEnd
  "tool_name": "Build",
  "status": "Compiling module X"   // optional display override
}
```

### Phase 3 — Agent creation with no transcript and no terminal

No new lifecycle code — reuse what exists:

- **Creation.** `hookEventHandler.ts` already handles unknown sessions: `sessionStart` carrying
  `transcriptPath` *or* `cwd` calls `sessionRouter.storePending(...)`, and the agent is only
  materialised once a confirming event (`turnEnd` / `permissionRequest`) arrives. That filter
  exists to drop transient no-activity sessions and suits a REST caller fine. `transcriptPath` is
  already explicitly optional ("undefined for providers without transcripts").
  → Correct curl sequencing (`sessionStart` then activity) is all that is required.
- **Tracking gate.** `isTrackedSession()` (`hookEventHandler.ts:92-100`) resolves a project dir
  from `transcriptPath ?? cwd` and requires it to match a known agent's `projectDir`, unless
  *Watch All Sessions* is on. **Decision needed:** a deliberate authenticated POST is inherently
  intentional, unlike an ambient background session, so the web provider should probably bypass
  this gate. Must be provider-scoped so Claude's behaviour is untouched.
- **Headless / ghost.** `isHeadless` already means exactly this case — "adopted from outside,
  so there is no terminal to focus" (`webview-ui/src/office/types.ts:226-229`), derived from
  `isExternal` in `useExtensionMessages.ts:32`, rendered translucent at
  `renderer.ts:405-407` behind the *Display Headless as Ghosts* setting (shipped in `b1401bd`).
  → Verify a web-provider agent lands on that path; broaden minimally only if it does not.
  Also confirm clicking such a character does not attempt to focus a nonexistent terminal.

### Phase 4 — Tool metadata reaches the webview

`clientMessageHandler.ts:229-230` sends `claudeProvider.readingTools` / `.subagentToolNames` to
the webview to pick reading-vs-typing animations. With two providers live this must become a union
across the registry (or be provider-aware), otherwise web-provider tool names get the wrong
animation. Prefer the union — it needs no protocol change.

### Phase 5 — Dev ergonomics (pure additions, zero conflict risk)

- `scripts/web-agent.sh` — reads `port` + `authToken` from `~/.pixel-agents/server.json` and wraps
  the curl call, so no manual token copying.
- `server/manual-web-events.http` — REST-Client sample mirroring `manual-hook-events.http`,
  walking `sessionStart → toolStart → toolEnd → permissionRequest → turnEnd → sessionEnd`.
- Short usage section in `docs/` once the wire format is final.

### Phase 6 — Tests

- **Unit** `server/__tests__/web.test.ts` — `normalizeHookEvent` per event kind plus malformed
  input, mirroring `claude.test.ts`.
- **Unit** registry routing — the Phase 1 regression guard: two provider ids, two providers.
- **E2E** (optional) a standalone spec driving a character entirely over HTTP. Read
  `e2e/README.md` → *"Mocking model & rules"* first; the standalone server is the single
  documented exception to the process-boundary rule, which is what makes this legal.

---

## 4. Contribution & drift strategy

- Branch `feat/web-provider` is cut from `upstream/main`; fork `main` stays a clean mirror.
  Rebase onto `upstream/main` periodically rather than letting `main` diverge.
- Phase 1 is the only phase touching shared files, and it reads as a bug fix toward the
  documented design — the most upstreamable framing. Phases 2, 5, 6 are new files only.
- Per `CONTRIBUTING.md`, before any PR: `npm run lint`, `check-types`, `asyncapi:validate`,
  `asyncapi:generate`, `e2e:inventory`, `build`, `test`, `e2e`. The AsyncAPI and e2e-inventory
  drift checks fail CI on any diff — regen and commit.
- PR titles must be conventional commits (CI-enforced, squash-merged). Suggested split:
  1. `refactor(server): resolve hook provider by providerId`
  2. `feat(server): add web (REST) hook provider`
- No AsyncAPI change is expected — this plan adds no new client/server message types. If that
  turns out to be wrong, regenerate `core/src/messages.ts` and commit it.

---

## 5. Open questions

1. Should the web provider bypass `isTrackedSession()` (Phase 3)? Leaning yes, provider-scoped.
2. Fixed tool vocabulary, or free-form tool names with a `readingTools` hint in the payload?
3. Should `sessionStart` be allowed to create an agent immediately, or keep the
   confirming-event requirement for consistency with Claude? Leaning keep, for consistency.
4. Auth: reuse the existing bearer token as-is (simplest, consistent), or is a separate
   scope/token warranted for an externally-driven provider?
