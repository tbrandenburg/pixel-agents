#!/usr/bin/env node
/**
 * simulate-devops-loop.mjs -- an ENDLESS, ever-running "cloud agents doing
 * DevOps" show, driven entirely over the web (REST) hook provider
 * (POST /api/hooks/web). Unlike simulate-devops-day.mjs (one scripted
 * 10-minute story with a beginning and an end), this never stops and never
 * resets: every role runs its own independent, staggered, randomized loop,
 * so there is no single global "day boundary" where everything despawns and
 * respawns at once. The office should feel like a living, continuously
 * staffed engineering org, not a video on repeat.
 *
 * The full DevOps circle, all running forever, all in parallel:
 *
 *   po-jordan          Planning -- always-on, endless backlog grooming +
 *                      story writing, never sessionEnds
 *   dev-alice / -bob   Coding -- pick up a new feature/bugfix each cycle,
 *                      code it, open a PR (feeds the CI queue), wait for
 *                      review, merge, sessionEnd, brief random pause, repeat
 *                      with a *different* randomly-picked ticket
 *   ci-runner          Build -- always-on, REACTS to PRs landing in the
 *                      queue (from either dev, or the whole team) by firing
 *                      an independent pipeline run per PR -- multiple runs
 *                      can and do overlap, each fanning out to 5 parallel
 *                      sub-agent characters (Lint/Unit Tests/Security
 *                      Scan/Contract Tests/Docker Build)
 *   qa-engineer        Test -- always-on, continuous exploratory/integration
 *                      testing with occasional flaky-test permission triage
 *   security-bot       Security/Compliance -- always-on continuous
 *                      dependency/SAST scanning with occasional CVE triage
 *                      permission gates -- the security lane of the circle
 *   release-mgr        Release/Deploy -- periodically (randomized interval)
 *                      bundles whatever's merged since the last release into
 *                      a new version: tag, changelog, staging, an explicit
 *                      production approval gate, then prod deploy
 *   sre-oncall         Operate/Monitor -- always-on dashboard watch;
 *                      periodically (randomized interval) a synthetic
 *                      incident fires: sub-agent investigation, a rollback
 *                      permission gate, paging a random developer, who
 *                      spawns as a brand-new short-lived hotfix session,
 *                      fixes it live, and despawns -- closing the loop back
 *                      to development, over and over, forever
 *
 * Every cycle picks fresh flavor text (feature/bug names, PR numbers, CVE
 * ids, incident descriptions) from randomized pools so the show never feels
 * like it's playing the same clip twice, and every role's cadence is
 * independently randomized/staggered so no two roles ever "reset" in sync.
 *
 * Usage:
 *   node scripts/simulate-devops-loop.mjs [--speed N] [--dry-run] [--port N] [--duration S]
 *
 *   --speed N     Time-compress all delays by N (default 1).
 *   --dry-run     Print events instead of POSTing them (no server needed).
 *   --port N      Override the port instead of reading ~/.pixel-agents/server.json.
 *   --duration S  Stop after S real seconds (default: run forever, Ctrl+C to stop).
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { banner, logEvent, logError, logWarn, startHeartbeat } from './devops-sim-log.mjs';

// ── CLI args ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = args.indexOf(flag);
  if (i === -1) return fallback;
  return args[i + 1];
}
const SPEED = Number(argValue('--speed', '1')) || 1;
const DRY_RUN = args.includes('--dry-run');
const PORT_OVERRIDE = argValue('--port', undefined);
const DURATION_S = Number(argValue('--duration', 'Infinity'));

// ── Small utilities ──────────────────────────────────────────────────────

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
function randInt(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}
function sleepS(seconds) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, (seconds * 1000) / SPEED)));
}

let running = true;
let toolIdCounter = 0;
function nextToolId() {
  return `t${++toolIdCounter}`;
}

const startedAt = Date.now();
function elapsedS() {
  return ((Date.now() - startedAt) / 1000).toFixed(1);
}

// ── Server discovery + event posting (mirrors scripts/web-agent.sh) ──────

function readServerConfig() {
  const serverJsonPath = path.join(homedir(), '.pixel-agents', 'server.json');
  let raw;
  try {
    raw = readFileSync(serverJsonPath, 'utf8');
  } catch {
    throw new Error(
      `Could not read ${serverJsonPath} -- is Pixel Agents running? (npx pixel-agents / node dist/cli.js)`,
    );
  }
  const parsed = JSON.parse(raw);
  const port = PORT_OVERRIDE ? Number(PORT_OVERRIDE) : parsed.port;
  const token = parsed.token;
  if (!port || !token) {
    throw new Error(`Could not read port/token from ${serverJsonPath}`);
  }
  return { port, token };
}

const config = DRY_RUN ? null : readServerConfig();

// ── Live stats for the heartbeat (see startHeartbeat below) ──────────────
let eventsSent = 0;
const activeSessions = new Set();

async function send(sessionId, event) {
  eventsSent++;
  if (event.hook_event_name === 'sessionStart') activeSessions.add(sessionId);
  if (event.hook_event_name === 'sessionEnd') activeSessions.delete(sessionId);
  logEvent(elapsedS(), sessionId, event);
  if (DRY_RUN) return;
  try {
    const response = await fetch(`http://127.0.0.1:${config.port}/api/hooks/web`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, ...event }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      logError(`HTTP ${response.status} for ${sessionId} ${event.hook_event_name}: ${text}`);
    }
  } catch (err) {
    logError(`failed to send event for ${sessionId}: ${err.message}`);
  }
}

async function toolCall(sessionId, name, status, durationSeconds) {
  const toolId = nextToolId();
  await send(sessionId, { hook_event_name: 'toolStart', tool_id: toolId, tool_name: name, status });
  await sleepS(durationSeconds);
  await send(sessionId, { hook_event_name: 'toolEnd', tool_id: toolId });
}

// ── Flavor pools (fresh text every cycle, never the same clip twice) ────

const FEATURES = [
  'dark mode toggle',
  'wishlist sync across devices',
  'loyalty points redemption',
  'address autocomplete',
  'subscription pause/resume',
  'gift wrapping option',
  'one-click reorder',
  'saved payment methods',
  'order tracking map',
  'referral discount codes',
  'accessibility audit fixes',
  'multi-currency checkout',
];

const BUGS = [
  'cart total rounding error',
  'session timeout too early',
  'duplicate order confirmation emails',
  'broken pagination on order history',
  'stale cache on checkout page',
  'race condition in inventory count',
  'timezone bug in delivery estimate',
  'memory leak in search autocomplete',
  'broken CSV export for large orders',
  'wrong tax calculation for EU orders',
];

const DEV_QUIRKS = [
  'Whiteboarding in my head',
  'Blaming the cache, as always',
  'Rubber-ducking with the office plant',
  'Reading the ticket a third time',
  'Suspiciously quiet keyboard sounds',
];

const TEST_FAILURE_LINES = [
  'Why is this passing locally but not in CI...',
  'Off-by-one error, classic',
  'Flaky test strikes again',
  'Turns out the fixture data was stale',
  'Someone hardcoded a timezone',
];

const REVIEW_LINES = [
  'Fixing the variable name they hated',
  'Adding the test case they asked for',
  'Squashing commits before merge',
  'Addressing "nit: rename this" for the fifth time',
  'Explaining why the abstraction is actually necessary',
];

const CI_IDLE_TOOLS = [
  { name: 'Bash', status: 'Tailing CI queue' },
  { name: 'Read', status: 'Reviewing pipeline config' },
  { name: 'Bash', status: 'Warming build cache' },
  { name: 'Bash', status: 'Pruning old Docker layers' },
  { name: 'Read', status: 'Checking runner disk usage' },
  { name: 'Grep', status: 'Searching for flaky test annotations' },
];

const QA_TOOLS = [
  { name: 'Exploratory Testing', status: 'Poking around the newest feature' },
  { name: 'Fuzzing checkout API', status: 'Fuzzing checkout API with malformed payloads' },
  { name: 'Grep', status: 'Grepping logs for stack traces' },
  { name: 'Bash', status: 'Running integration suite against staging' },
  { name: 'Regression Sweep', status: 'Running smoke tests on latest build' },
  { name: 'Read', status: 'Reviewing test coverage report' },
];

const SEC_TOOLS = [
  { name: 'SAST Scan', status: 'Running static analysis on latest commits' },
  { name: 'Dependency Audit', status: 'Auditing package-lock for known CVEs' },
  { name: 'License Check', status: 'Checking third-party license compliance' },
  { name: 'Secrets Scan', status: 'Scanning history for leaked credentials' },
  { name: 'Bash', status: 'Rotating stale API keys' },
];

const PO_TOOLS = [
  { name: 'Backlog Grooming', status: 'Untangling backlog spaghetti' },
  { name: 'Slack Triage', status: "Answering 'is this done yet?' x7" },
  { name: 'Prioritizing Sprint Board', status: 'Playing Jira Tetris' },
  { name: 'Stakeholder Sync', status: 'Explaining scope creep, again' },
  { name: 'Read', status: "Reading last sprint's retro notes" },
  { name: 'WebSearch', status: 'Checking what competitors shipped this week' },
];

const INCIDENTS = [
  'Checkout latency p99 spiked to 4s',
  'Elevated 500s on the payments service',
  'Search index falling behind by 10 minutes',
  'Database connection pool exhausted',
  'CDN cache hit rate collapsed to 20%',
];

const HOTFIX_LINES = [
  'Reverting migration before it eats someone\u2019s order',
  'Rolling back the bad feature flag',
  'Patching the null check that slipped through review',
  'Scaling the connection pool back up',
];

// ── Shared queues (roles react to each other -- this is what makes the
// parallelism organic instead of a fixed clock tick) ─────────────────────

/** @type {{author:string, branch:string, title:string}[]} */
const ciQueue = [];
/** @type {{author:string, title:string}[]} */
const releaseQueue = [];

// ── Roles ────────────────────────────────────────────────────────────────

async function poLoop() {
  const id = 'po-jordan';
  await sleepS(randInt(0, 3));
  await send(id, { hook_event_name: 'sessionStart', cwd: '/demo/pixel-shop-platform' });
  await sleepS(1.5);
  let n = 0;
  while (running) {
    n++;
    const t = pick(PO_TOOLS);
    await toolCall(id, t.name, t.status, randInt(15, 30));
    if (n % 4 === 0) {
      const feature = pick(FEATURES);
      await toolCall(
        id,
        `Writing User Story: ${feature}`,
        'Drafting acceptance criteria',
        randInt(20, 35),
      );
    }
    if (Math.random() < 0.12) {
      await send(id, { hook_event_name: 'turnEnd', awaiting_input: true });
      await sleepS(randInt(20, 40));
    }
  }
}

async function devLoop(name, cwd) {
  let cycle = 0;
  await sleepS(randInt(0, 4));
  while (running) {
    cycle++;
    const sessionId = `${name}-${cycle}`;
    const isBugfix = Math.random() < 0.4;
    const ticket = isBugfix ? pick(BUGS) : pick(FEATURES);
    const prNum = 100 + randInt(1, 899);
    await send(sessionId, { hook_event_name: 'sessionStart', cwd });
    await sleepS(1.5);
    await toolCall(sessionId, 'Read', `Reading ticket: ${ticket}`, randInt(6, 12));
    await toolCall(sessionId, 'Grep', 'Searching codebase for related logic', randInt(5, 10));
    await toolCall(
      sessionId,
      isBugfix ? 'Reproducing Bug Locally' : 'Sketching Approach',
      pick(DEV_QUIRKS),
      randInt(10, 20),
    );
    await toolCall(sessionId, 'Edit', `Implementing: ${ticket}`, randInt(20, 45));
    await toolCall(sessionId, 'Bash', 'Running test suite', randInt(10, 20));
    if (Math.random() < 0.3) {
      await toolCall(
        sessionId,
        'Untangling Test Failure',
        pick(TEST_FAILURE_LINES),
        randInt(15, 30),
      );
    }
    await toolCall(sessionId, 'git commit', `${isBugfix ? 'fix' : 'feat'}: ${ticket}`, 4);
    const branch = `${name}/${ticket.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
    await toolCall(
      sessionId,
      `Opening PR #${prNum}`,
      `${isBugfix ? 'Bugfix' : 'Feature'}: ${ticket}`,
      6,
    );
    ciQueue.push({ author: name, branch, title: `#${prNum} ${ticket}` });
    await send(sessionId, { hook_event_name: 'turnEnd', awaiting_input: true });
    await sleepS(randInt(25, 45));
    await toolCall(sessionId, 'Responding to Review Comments', pick(REVIEW_LINES), randInt(10, 25));
    await send(sessionId, { hook_event_name: 'turnEnd', awaiting_input: false });
    await send(sessionId, { hook_event_name: 'sessionEnd', reason: 'merged' });
    releaseQueue.push({ author: name, title: ticket });
    await sleepS(randInt(3, 9)); // short, randomized gap before the next ticket -- never synced with other roles
  }
}

let pipelineCounter = 0;

/** Fire-and-forget: pipeline runs are NOT awaited by the caller, so multiple
 *  runs can genuinely overlap when PRs land close together -- maximum
 *  parallelism, not a serialized queue. */
async function runPipeline(ciId, job) {
  pipelineCounter++;
  const parentToolId = nextToolId();
  await send(ciId, {
    hook_event_name: 'toolStart',
    tool_id: parentToolId,
    tool_name: 'Pipeline Run',
    status: `Pipeline Run: ${job.branch} -- ${job.title}`,
  });
  const subs = [
    { name: 'Lint', status: 'Running ESLint + Prettier check', dur: randInt(5, 10) },
    { name: 'Unit Tests', status: 'Running Jest suite', dur: randInt(12, 24) },
    { name: 'Security Scan', status: 'Scanning deps with Trivy', dur: randInt(15, 30) },
    { name: 'Contract Tests', status: 'Verifying API contracts', dur: randInt(8, 16) },
    {
      name: 'Docker Build',
      status: 'Building multi-stage image (amd64/arm64)',
      dur: randInt(20, 45),
    },
  ];
  await Promise.all(
    subs.map(async (s, i) => {
      await sleepS(i * 0.4);
      const subId = nextToolId();
      await send(ciId, {
        hook_event_name: 'subagentStart',
        parent_tool_id: parentToolId,
        tool_id: subId,
        tool_name: s.name,
        status: s.status,
      });
      await sleepS(s.dur);
      await send(ciId, {
        hook_event_name: 'subagentEnd',
        parent_tool_id: parentToolId,
        tool_id: subId,
      });
    }),
  );
  await send(ciId, { hook_event_name: 'toolEnd', tool_id: parentToolId });
}

async function ciLoop() {
  const id = 'ci-runner';
  await sleepS(randInt(0, 2));
  await send(id, { hook_event_name: 'sessionStart', cwd: '/workspace/devops-monorepo' });
  await sleepS(1);
  while (running) {
    if (ciQueue.length === 0) {
      const t = pick(CI_IDLE_TOOLS);
      await toolCall(id, t.name, t.status, randInt(5, 12));
      await sleepS(randInt(3, 8));
      continue;
    }
    const job = ciQueue.shift();
    void runPipeline(id, job); // deliberately not awaited -- overlapping runs are the point
    await sleepS(randInt(2, 6));
  }
}

async function qaLoop() {
  const id = 'qa-engineer';
  await sleepS(randInt(0, 5));
  await send(id, { hook_event_name: 'sessionStart', cwd: '/workspace/devops-monorepo/qa' });
  await sleepS(2);
  while (running) {
    const t = pick(QA_TOOLS);
    await toolCall(id, t.name, t.status, randInt(10, 25));
    if (Math.random() < 0.15) {
      const testName = pick(['test_cart_rounding', 'test_checkout_flow', 'test_session_timeout']);
      await toolCall(id, 'Chasing a flaky test', `Re-running ${testName} 5x`, randInt(10, 18));
      await send(id, { hook_event_name: 'permissionRequest' });
      await sleepS(randInt(8, 15));
      await toolCall(
        id,
        'Manual Triage',
        'Comparing flaky failure against last 10 runs',
        randInt(8, 14),
      );
      await send(id, { hook_event_name: 'turnEnd', awaiting_input: false });
    }
    if (Math.random() < 0.1) {
      await send(id, { hook_event_name: 'turnEnd', awaiting_input: true });
      await sleepS(randInt(15, 30));
    }
  }
}

async function securityLoop() {
  const id = 'security-bot';
  await sleepS(randInt(0, 6));
  await send(id, { hook_event_name: 'sessionStart', cwd: '/workspace/security-compliance' });
  await sleepS(2);
  while (running) {
    const t = pick(SEC_TOOLS);
    await toolCall(id, t.name, t.status, randInt(15, 30));
    if (Math.random() < 0.2) {
      const cve = `CVE-2025-${randInt(10000, 99999)}`;
      await toolCall(
        id,
        'Dependency Audit',
        `Found ${cve} in a transitive dependency`,
        randInt(6, 10),
      );
      await send(id, { hook_event_name: 'permissionRequest' });
      await sleepS(randInt(10, 20));
      await toolCall(
        id,
        'Risk Assessment',
        `Classifying ${cve} as low severity (no exploit path)`,
        randInt(6, 10),
      );
      await send(id, { hook_event_name: 'turnEnd', awaiting_input: false });
    }
  }
}

let releaseCounter = 4;
async function releaseLoop() {
  await sleepS(randInt(30, 60));
  while (running) {
    releaseCounter++;
    const sessionId = `release-mgr-${releaseCounter}`;
    const batch = releaseQueue.splice(0, releaseQueue.length);
    const version = `v2.${releaseCounter}.0`;
    await send(sessionId, { hook_event_name: 'sessionStart', cwd: '/workspace/deploy-tools' });
    await sleepS(0.5);
    await toolCall(sessionId, 'GitTag', `Tagging ${version}`, randInt(3, 6));
    await toolCall(
      sessionId,
      'ChangelogGen',
      batch.length
        ? `Compiling changelog from ${[...new Set(batch.map((b) => b.author))].join('+')} commits`
        : 'Compiling changelog (maintenance release)',
      randInt(6, 12),
    );
    await toolCall(sessionId, 'ArtifactBuild', 'Building release artifacts', randInt(10, 16));
    await toolCall(sessionId, 'StagingDeploy', 'Deploying to staging', randInt(10, 16));
    await toolCall(sessionId, 'SmokeTest', 'Running staging smoke tests', randInt(12, 20));
    await send(sessionId, { hook_event_name: 'permissionRequest' });
    await sleepS(randInt(5, 10));
    await send(sessionId, { hook_event_name: 'turnEnd', awaiting_input: false });
    await toolCall(sessionId, 'ProdDeploy', `Deploying ${version} to production`, randInt(15, 25));
    await toolCall(sessionId, 'DeployVerify', 'Verifying production rollout', randInt(6, 10));
    await send(sessionId, { hook_event_name: 'sessionEnd', reason: 'release train complete' });
    await sleepS(randInt(150, 240)); // next release train, randomized interval -- never a fixed metronome
  }
}

let hotfixCounter = 0;

/** A brand-new agent spawning mid-show, every time -- the signature "cloud
 *  agent gets paged in live" beat, repeatable forever. */
async function runHotfix(devName, incidentDesc) {
  hotfixCounter++;
  const sessionId = `dev-${devName}-hotfix-${hotfixCounter}`;
  await send(sessionId, { hook_event_name: 'sessionStart', cwd: '/workspace/checkout-service' });
  await sleepS(1);
  await toolCall(sessionId, 'GitCheckout', 'Checking out hotfix branch', randInt(3, 6));
  await toolCall(sessionId, 'RevertMigration', pick(HOTFIX_LINES), randInt(10, 20));
  await toolCall(sessionId, 'RunTests', 'Running regression tests', randInt(8, 15));
  await send(sessionId, { hook_event_name: 'turnEnd', awaiting_input: false });
  await toolCall(
    sessionId,
    'DeployHotfix',
    `Deploying hotfix for: ${incidentDesc}`,
    randInt(12, 20),
  );
  await send(sessionId, { hook_event_name: 'turnEnd', awaiting_input: false });
  await send(sessionId, { hook_event_name: 'sessionEnd', reason: 'hotfix deployed' });
}

async function triggerIncident(sreId) {
  const incidentDesc = pick(INCIDENTS);
  await toolCall(sreId, 'AlertTriage', incidentDesc, randInt(4, 8));
  // Investigation sub-agent groups under a synthetic parent id -- AlertTriage's
  // own tool already ended above; subagentStart just needs *a* parent_tool_id
  // to group under, not a currently-open one.
  const alertToolId = nextToolId();
  const investigateSubId = nextToolId();
  await send(sreId, {
    hook_event_name: 'subagentStart',
    parent_tool_id: alertToolId,
    tool_id: investigateSubId,
    tool_name: 'Investigating anomaly',
  });
  const subId1 = nextToolId();
  await send(sreId, {
    hook_event_name: 'toolStart',
    tool_id: subId1,
    tool_name: 'QueryMetrics',
    status: 'Querying p99 latency by service',
  });
  await sleepS(randInt(6, 10));
  await send(sreId, { hook_event_name: 'toolEnd', tool_id: subId1 });
  const subId2 = nextToolId();
  await send(sreId, {
    hook_event_name: 'toolStart',
    tool_id: subId2,
    tool_name: 'QueryLogs',
    status: 'Grepping error logs for the affected service',
  });
  await sleepS(randInt(6, 10));
  await send(sreId, { hook_event_name: 'toolEnd', tool_id: subId2 });
  await send(sreId, {
    hook_event_name: 'subagentEnd',
    parent_tool_id: alertToolId,
    tool_id: investigateSubId,
  });
  await send(sreId, { hook_event_name: 'permissionRequest' });
  await sleepS(randInt(4, 8));
  await send(sreId, { hook_event_name: 'turnEnd', awaiting_input: true });
  const pagedDev = pick(['alice', 'bob']);
  await toolCall(sreId, 'PageDeveloper', `Paging dev-${pagedDev} -- prod incident`, 3);
  await send(sreId, { hook_event_name: 'turnEnd', awaiting_input: true });
  await runHotfix(pagedDev, incidentDesc);
  const incidentNum = 1000 + randInt(1, 999);
  await toolCall(
    sreId,
    'CloseIncident',
    `Closing incident ticket INC-${incidentNum}`,
    randInt(3, 6),
  );
  await send(sreId, { hook_event_name: 'turnEnd', awaiting_input: false });
}

async function sreLoop() {
  const id = 'sre-oncall';
  await sleepS(randInt(0, 3));
  await send(id, { hook_event_name: 'sessionStart', cwd: '/workspace/observability' });
  await sleepS(1);
  while (running) {
    const watchId = nextToolId();
    await send(id, {
      hook_event_name: 'toolStart',
      tool_id: watchId,
      tool_name: 'DashboardWatch',
      status: 'Watching golden signals dashboard',
    });
    await sleepS(randInt(90, 180)); // time between incidents -- randomized, never a fixed metronome
    await send(id, { hook_event_name: 'toolEnd', tool_id: watchId });
    await triggerIncident(id);
  }
}

// ── Entry point ──────────────────────────────────────────────────────────

async function main() {
  const lines = [
    'Starting the endless DevOps circle: 8 roles, running forever in parallel.',
    'Ctrl+C to stop.',
  ];
  if (DRY_RUN) lines.push('(dry run -- printing events, not sending them)');
  else lines.push(`Posting to http://127.0.0.1:${config.port}/api/hooks/web`);
  if (Number.isFinite(DURATION_S)) lines.push(`(capped at ${DURATION_S}s for this run)`);
  banner(lines);

  startHeartbeat(20_000, () => {
    const agents = [...activeSessions].sort().join(', ') || 'none yet';
    return `still running -- +${elapsedS()}s elapsed, ${eventsSent} events sent, active agents: ${agents}`;
  });

  if (Number.isFinite(DURATION_S)) {
    setTimeout(() => {
      running = false;
      logWarn('Duration reached, stopping. (Loops finish their current step, then exit.)');
      setTimeout(() => process.exit(0), 2000);
    }, DURATION_S * 1000); // real wall-clock seconds, deliberately NOT divided by SPEED
  }

  process.on('SIGINT', () => {
    logWarn('Interrupted -- stopping.');
    process.exit(130);
  });

  await Promise.all([
    poLoop(),
    ciLoop(),
    qaLoop(),
    securityLoop(),
    sreLoop(),
    devLoop('dev-alice', '/demo/pixel-shop-checkout-service'),
    devLoop('dev-bob', '/demo/pixel-shop-cart-service'),
    releaseLoop(),
  ]);
}

main().catch((err) => {
  logError(`Fatal: ${err.message}`);
  process.exit(1);
});
