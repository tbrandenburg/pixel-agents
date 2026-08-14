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

Non-goal: a general REST *control/query* API. This plan only covers the ingestion direction
(events → runtime), matching what `POST /api/hooks/:providerId` already is. Listing agents,
launching/closing/focusing an agent, or reading current state remain WebSocket
`ClientMessage`/`ServerMessage` concerns and are untouched by this plan.

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
    static config over a caller-defined tool vocabulary. **Resolved: free-form tool names, not a
    fixed vocabulary**, because unlike Claude's closed set of built-in tools, any external
    script/tool can be the caller here and can't be enumerated up front. Keep
    `readingTools`/`subagentToolNames`/`permissionExemptTools` as empty-set defaults/backstop
    (matching the `HookProvider` interface shape in `core/src/provider.ts:88-97`), but add
    **optional per-event hints** so a caller can self-classify at the point of use:
    `toolStart`/`subagentStart` gain optional `isReadingTool?: boolean`, `isSubagentTool?: boolean`,
    and `statusText?: string` fields on `AgentEvent` (`core/src/provider.ts`). `web.ts`'s
    `formatToolStatus` prefers `statusText` when present, else falls back to `Using ${toolName}` —
    no switch needed. The webview's `isReadingToolName`/`isSubagentToolName`
    (`webview-ui/src/office/toolUtils.ts:55-61`) need to consult the per-event hint carried on the
    `agentToolStart`/`subagentToolStart` broadcast before falling back to the static
    `providerCapabilities` snapshot (`clientMessageHandler.ts:229-230`, sent once at
    `webviewReady` today). This is additive to the AsyncAPI contract (new optional fields on
    existing message variants) rather than a new message type.
  - Deliberately **omits** every optional member: no `getSessionDirs`, `getAllSessionRoots`,
    `sessionFilePattern`, `parseTranscriptLine`, `buildLaunchCommand`, `terminalNamePrefix`,
    no `team`.
- `constants.ts` — event-name vocabulary and defaults.

### Phase 2a — Coverage: one endpoint, every applicable `AgentEvent` kind

`POST /api/hooks/web` is a single route, same as Claude's — `normalizeHookEvent` discriminates on
an event-name field, exactly like `claude.ts`'s `switch (raw.hook_event_name)`. That pattern
already scales to every kind; the table below makes the scope explicit instead of leaving it to
be inferred from one partial example.

`AgentEvent` has 9 kinds. Claude's `normalizeHookEvent` maps its 11 raw hook names onto 8 of them
(`progress` is never hook-driven — it only exists in the JSONL/file-fallback path, which this
provider has none of). Coverage for the web provider:

| `AgentEvent.kind` | In scope? | Web event name | Notes |
| --- | --- | --- | --- |
| `sessionStart` | Yes | `sessionStart` | Requires `cwd`; drives Phase 3 pending-session creation |
| `sessionEnd` | Yes | `sessionEnd` | Optional `reason` |
| `toolStart` | Yes | `toolStart` | `toolId`, `toolName`, optional `input`, `status` override |
| `toolEnd` | Yes | `toolEnd` | `toolId` |
| `turnEnd` | Yes | `turnEnd` | Optional `awaitingInput` (maps to Claude's idle vs. done distinction) |
| `permissionRequest` | Yes | `permissionRequest` | No extra fields required |
| `subagentStart` | Yes | `subagentStart` | `parentToolId`, `toolId`, `toolName`; enables the plain (non-team) sub-agent character, same as Claude's `Task`/`Agent` tools |
| `subagentEnd` | Yes | `subagentEnd` | `parentToolId`, `toolId` |
| `subagentTurnEnd` | **No** | — | Tied to Agent Teams (`TeammateIdle`/`TaskCompleted`); Phase 2 omits `team` entirely, so this kind has no web-provider equivalent |
| `progress` | **No** | — | Not hook-driven for any provider; JSONL/file-fallback only, which this provider intentionally has none of |

So the provider is complete for **every kind reachable via hooks in a non-team CLI** — the same
subset Claude itself would produce with Agent Teams turned off. It is *not* a complete stand-in
for team/transcript features, by design (see Phase 2's explicit list of omitted optional
`HookProvider` members).

Full wire shape (supersedes the earlier partial example — one schema, `hook_event_name`
discriminates all 8 in-scope kinds):

```jsonc
POST /api/hooks/web
{
  "session_id": "demo-1",            // required; the routing key on every event
  "hook_event_name": "toolStart",    // one of the 8 rows above marked "Yes"
  "cwd": "/path/to/project",         // required on sessionStart only
  "reason": "exit",                  // sessionEnd only, optional
  "awaiting_input": false,           // turnEnd only, optional
  "parent_tool_id": "t0",            // subagentStart / subagentEnd only
  "tool_id": "t1",                   // toolStart / toolEnd / subagentStart / subagentEnd
  "tool_name": "Build",              // toolStart / subagentStart
  "input": { "target": "release" },  // toolStart / subagentStart, optional
  "status": "Compiling module X"     // optional display override, any tool event
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
  **Resolved: keep the pending/confirm pattern, no immediate materialization on `sessionStart`
  alone.** `sessionRouter.ts`'s pending map has no TTL/expiry (`storePending`/`confirmPending`/
  `discardPending`, a plain `Map` cleared only on `dispose()` or a matching `sessionEnd`), so an
  abandoned `sessionStart`-only REST call costs nothing more than a small in-memory entry —
  contrast with immediate materialization, which would render a visible ghost/headless character
  for every stray or duplicate `sessionStart`, with no natural "process exited" signal to clean it
  up automatically (unlike Claude, where even an accidental session still fires `SessionEnd`).
  `e2e/tests/standalone/hooks.spec.ts:20-33` already locks this contract in for Claude (`sessionStart`
  → `expectOverlayCount(page, 0)`, confirmed only after the next activity event) and Phase 8 below
  reuses that exact assertion shape for the web provider. This is provider-agnostic logic already
  keyed only on `HookEvent`/`AgentEvent`, so it needs no change to support the web provider — just
  correct curl/script sequencing.
- **Tracking gate.** `isTrackedSession()` (`hookEventHandler.ts:92-100`) resolves a project dir
  from `transcriptPath ?? cwd` and requires it to match a known agent's `projectDir`, unless
  *Watch All Sessions* is on. **Resolved: no bypass needed, because there's nothing to bypass.**
  `isTrackedSession()`'s return value is dead for control flow in `hookEventHandler.ts` — its
  three call sites are all `if (debug && tracked) console.log(...)` (lines 176, 238, 248);
  `storePending()` and every other branch execute unconditionally regardless of `tracked`. The
  real admission gate for ambient/external sessions lives in `agentRuntime.ts:195`
  (`if (!isTrackedProjectDir(projectDir) && !this.watchAllSessions.current) return;`, inside
  `onExternalSessionDetected`) — provider-agnostic today, fed only by `projectDir`/
  `watchAllSessions`. Leave both untouched for launch: a valid bearer token authenticates the
  *caller*, not the *workspace*, so bypassing `agentRuntime.ts:195` would let an authenticated POST
  with an arbitrary `cwd` adopt sessions for projects never opened in this instance — a strictly
  larger capability than Claude's hook path grants, and worse UX for a REST caller (no natural
  `SessionEnd` follow-through the way an exiting CLI process gives you, so a stray/typo'd `cwd`
  leaves a zombie pending session). If cross-workspace REST adoption is wanted later, it should be
  an explicit, provider-scoped opt-in at `agentRuntime.ts:195` (e.g. a `provider.trustedOrigin`
  flag), not a change to `isTrackedSession()`.
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
- **E2E** — see Phase 8 below: a standalone spec driving a character entirely over HTTP
  (curl-equivalent `sendHookEvent` calls) while Playwright observes spawn/move/despawn in a real
  browser. No longer optional — this is the plan's primary proof that the provider works.

### Phase 7 — Enablement & ergonomics: how a user actually turns this on

Because Phase 1 turns the runtime into a **registry** rather than a single active provider, there
is no "select the web provider" step. `claude` and `web` are both always live at
`/api/hooks/claude` and `/api/hooks/web` simultaneously — configuring *which* provider is active
is not a concept that exists after this change.

**End-to-end startup sequence** (no new CLI flags, no new config keys required for the happy
path):

```bash
# 1. Start Pixel Agents exactly as today
npx pixel-agents --port 3100
# (or open the VS Code panel — the HTTP server always starts regardless of the
#  hooksEnabled setting, per the existing "Server always starts" key decision,
#  so /api/hooks/web is reachable the moment the server is up)

# 2. Discover the endpoint + token (same file every provider already relies on)
cat ~/.pixel-agents/server.json   # { port, pid, authToken }

# 3. Drive an agent
./scripts/web-agent.sh '{"session_id":"demo-1","hook_event_name":"sessionStart","cwd":"'"$PWD"'"}'
./scripts/web-agent.sh '{"session_id":"demo-1","hook_event_name":"toolStart","tool_id":"t1","tool_name":"Build"}'
```

This is arguably *more* comfortable than onboarding the Claude provider: Claude's `installHooks()`
writes into `~/.claude/settings.json` and needs a real CLI session; the web provider's
`installHooks`/`areHooksInstalled` are no-ops (Phase 2), so there is nothing to install or verify.

**Two comfort/security gaps identified, one resolved, one deferred:**

1. **Token discovery is manual every time.** Reading `server.json` by hand before every curl
   session is fine scripted, mildly annoying live. Candidate improvement: a
   `pixel-agents --print-web-endpoint` flag emitting an exportable
   `PIXEL_AGENTS_URL`/`PIXEL_AGENTS_TOKEN` pair. Small, additive, no conflict risk — deferred to
   a follow-up rather than blocking this plan.
2. **No opt-out exists — resolved as Option A (always-on).** `POST /api/hooks/:providerId` is
   registered unconditionally at server boot (`httpServer.ts:107-135`) with only bearer-token auth
   as `preHandler` — there is no reference to `hooksEnabled`/`watchAllSessions` anywhere in
   `httpServer.ts` (confirmed by grep), matching the documented key decision that the server always
   starts and only *hook installation* is gated by settings. A web provider has no installer
   side-effect to gate in the first place (unlike Claude's `~/.claude/settings.json` write), so
   there's no natural "off" state to map a toggle onto. A `webProviderEnabled` setting (Option B)
   was scoped and rejected for launch: it would touch 7+ files end-to-end (AsyncAPI schema +
   generated `messages.ts` with a mandatory CI drift check, `configPersistence.ts`'s
   `AdapterSettings`/key list/defaults/parser, `clientMessageHandler.ts`, both VS Code and
   standalone wiring, `SettingsModal.tsx`/`App.tsx`) for roughly half a day to a day of work,
   disproportionate to gating a boolean with no corresponding installer to disable. The bearer
   token already gates the entire hook endpoint for every provider uniformly — this is not a new
   trust boundary, only a new use of an existing one. Revisit only if a concrete abuse case
   specific to the web provider emerges; the pattern to replicate then is `hooksEnabled` end to end.

### Phase 8 — End-to-end: curl on one side, Playwright watching on the other

The point of this provider is that a human (or script) can drive it with `curl` while a real
browser renders the result — so the e2e test should prove exactly that, not simulate it through
internals.

This is the standalone exception already carved out in `e2e/README.md` → *"Mocking model &
rules"*: `standalone/hooks.spec.ts` has no VS Code terminal to host a mocked CLI, so it POSTs to
the server's hook endpoint directly via the `sendHookEvent` helper — that is the one sanctioned
place a test talks to the hook endpoint directly instead of going through the `claudeScenario`
builder. The web-provider test fits this exact shape, one level more literally: the "mock" *is*
curl, because curl is the real client for this provider.

- **New file** `e2e/tests/standalone/web-provider.spec.ts`, reusing the `standalone` fixture
  (spawns the real Fastify server + a real browser page against it — no VS Code).
- **Driving side**: use `sendHookEvent(standalone.hookServerConfig, {...})`
  (`e2e/helpers/hooks.ts`) exactly as `standalone/hooks.spec.ts` does, but targeted at
  `POST /api/hooks/web` instead of `/api/hooks/claude`, with the web provider's own payload shape
  from Phase 2. This is literally the same HTTP call `curl` would make — the test is not
  special-cased, it's the same helper wrapping the same request a human curl invocation performs.
  A companion snippet in the plan/docs will show the equivalent raw `curl` for manual reproduction.
- **Observing side**: assert only on Playwright-visible outcomes, per the project's e2e rules —
  no reaching into server/store internals:
  1. `sessionStart` (with `cwd`) → **no** overlay yet (`expectOverlayCount(page, 0)`), proving the
     pending-session behaviour from Phase 3 also holds for this provider — mirrors the existing
     negative-assertion wait pattern in `standalone/hooks.spec.ts`.
  2. `toolStart` (confirming event) → the agent **spawns**: overlay appears
     (`expectOverlayVisible`), matrix spawn effect settles, character is rendered `isHeadless`
     (ghost) once *Display Headless as Ghosts* is enabled via `setSettings`.
  3. A second `toolStart`/`toolEnd` pair with a different `tool_name` → the character **moves**
     between wander/active states and the tool overlay label updates — asserted via the office
     helpers (`e2e/helpers/office.ts`), not raw canvas pixel inspection.
  4. `subagentStart`/`subagentEnd` → a sub-agent character spawns next to the parent and despawns
     on completion — covers the two remaining "Yes" rows in the Phase 2a coverage table so the
     e2e run exercises all 8 in-scope kinds, not just the tool/session subset.
  5. `sessionEnd` → despawn (matrix effect), overlay gone.
- **Regression coverage this buys**: proves Phase 1 routing end-to-end (a *different* provider id
  reaches a *different* code path and still renders correctly), proves Phase 3's headless/pending
  behaviour without any Claude-specific transcript involved, and proves Phase 4's tool-metadata
  union (the web provider's own tool vocabulary must still pick correct reading/typing animation).
- **Inventory**: tag `@area:standalone` (existing area) or add a new `@area:web-provider` tag if
  the suite grows past one spec — decide at implementation time. Either way, run
  `npm run e2e:inventory` and commit the regenerated `e2e/README.md` section, since CI fails on
  any drift there.

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

## 5. Open questions — resolved

1. **Should the web provider bypass `isTrackedSession()` (Phase 3)?** No — resolved as **not
   applicable**. `isTrackedSession()`'s return value is dead for control flow (its call sites are
   debug-log-only); the actual admission gate is `agentRuntime.ts:195`
   (`isTrackedProjectDir`/`watchAllSessions`), which is already provider-agnostic and stays
   untouched. See Phase 3 above for the full reasoning and the risk a bypass there would introduce
   (cross-workspace adoption from an authenticated-but-arbitrary `cwd`).
2. **Fixed tool vocabulary, or free-form tool names with a `readingTools` hint in the payload?**
   **Free-form**, with optional per-event `isReadingTool`/`isSubagentTool`/`statusText` hints on
   `toolStart`/`subagentStart`. A REST provider can't enumerate a caller-defined vocabulary up
   front the way Claude's fixed built-in tool set allows. See Phase 2 above for the field-level
   detail.
3. **Should `sessionStart` create an agent immediately, or keep the confirming-event requirement?**
   **Keep the confirming-event requirement.** The pending map has no TTL and costs nothing on
   abandonment; immediate materialization would render a ghost character for every stray/duplicate
   `sessionStart` with no automatic cleanup signal. See Phase 3 above.
4. **Auth: reuse the existing bearer token, or a separate scope/token?** **Reuse the existing
   token.** `providerId` never participates in auth today (`bearerAuth` closes over one token for
   the whole `/api/hooks/:providerId` route); there is no prior art for per-provider tokens (VS
   Code and standalone already share one token per server process), and a separate token would add
   a second secret to manage without shrinking the existing trust boundary (same route, same
   middleware) — it only becomes worthwhile if auth becomes provider-aware, which nothing here
   requires. A separate token is estimated as medium-cost (provider-aware `bearerAuth`, a second
   persisted secret, script/doc updates) should it ever be wanted for defense-in-depth.
5. **Always-on (Option A), or gated by a new `webProviderEnabled` setting (Option B)?**
   **Option A, always-on.** The hook route is already unconditional at boot regardless of
   `hooksEnabled`/`watchAllSessions`, matching the "server always starts" key decision; the web
   provider has no installer side-effect to gate, so a toggle has no natural "off" behavior to map
   onto and would cost roughly half a day to a day across 7+ files (AsyncAPI + generated bindings,
   `configPersistence.ts`, `clientMessageHandler.ts`, both adapters, webview settings UI) for that
   marginal benefit. See Phase 7 above.

All five questions were resolved by direct code inspection (see the corresponding phase sections
for file:line evidence) rather than left as leanings — no further design decisions are blocking
before implementation starts.
