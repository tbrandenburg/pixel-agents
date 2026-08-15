#!/usr/bin/env node
/**
 * simulate-devops-day.mjs -- a 10-minute (600s), fast-forwarded "day in the
 * life of a DevOps team", driven entirely over the web (REST) hook provider
 * (POST /api/hooks/web). No CLI, no transcript, no terminal -- just this
 * script talking to a running Pixel Agents server, the same way
 * scripts/web-agent.sh or a real curl invocation would.
 *
 * Eight parallel "agents" (each just a session_id) play out one consistent
 * story across the DevOps loop -- plan -> code -> build -> test -> release ->
 * deploy -> operate -> incident -> back to code -- overlapping in time the
 * way a real team's work actually does:
 *
 *   po-jordan-01      Product Owner / Planner
 *   dev-alice-01      Developer -- feature (checkout discount codes)
 *   dev-bob-01        Developer -- bugfix (cart rounding error)
 *   ci-runner         CI/Build engineer (2 pipeline runs, 4 parallel sub-agents each)
 *   qa-engineer       QA/Test engineer (flaky-test triage, permissionRequest)
 *   release-mgr       Release manager (staging -> approval gate -> production)
 *   sre-oncall        SRE/on-call (post-deploy incident response, rollback gate)
 *   dev-alice-hotfix  A brand-new mid-simulation agent, paged in to fix the incident live
 *
 * Usage:
 *   node scripts/simulate-devops-day.mjs [--speed N] [--dry-run] [--port N]
 *
 *   --speed N   Time-compress the whole schedule by N (default 1 = real
 *               10 minutes). --speed 10 replays the same story in ~60s --
 *               handy for testing the script itself.
 *   --dry-run   Print every event instead of POSTing it (no server needed).
 *   --port N    Override the port instead of reading ~/.pixel-agents/server.json.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

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

// ── Story data ──────────────────────────────────────────────────────────
//
// Each agent is a list of timed actions. `t` is the absolute second offset
// in the *real* 600s day (before --speed compression is applied). Actions
// are translated to wire events by buildEvents() below -- see
// docs/web-provider-plan.md Phase 2a for the full event vocabulary.

/** @typedef {{t:number, type:string, [key:string]: unknown}} Action */

/** @type {{id:string, cwd:string, actions:Action[]}[]} */
const AGENTS = [
  {
    id: 'po-jordan-01',
    cwd: '/demo/pixel-shop-platform',
    actions: [
      { t: 2, type: 'sessionStart' },
      {
        t: 10,
        type: 'tool',
        id: 't1',
        name: 'Backlog Grooming',
        status: 'Untangling backlog spaghetti',
        end: 35,
      },
      {
        t: 40,
        type: 'tool',
        id: 't2',
        name: 'Read',
        status: "Reading last sprint's retro notes",
        end: 52,
      },
      {
        t: 70,
        type: 'tool',
        id: 't3',
        name: 'Writing User Story: Checkout Discount Codes',
        status: 'Drafting acceptance criteria',
        end: 100,
      },
      {
        t: 110,
        type: 'tool',
        id: 't4',
        name: 'WebSearch',
        status: 'Checking competitor checkout flows',
        end: 125,
      },
      {
        t: 160,
        type: 'tool',
        id: 't5',
        name: 'Sketching Wireframe',
        status: 'Doodling discount-code input box',
        end: 180,
      },
      {
        t: 190,
        type: 'tool',
        id: 't6',
        name: 'Prioritizing Sprint Board',
        status: 'Playing Jira Tetris',
        end: 208,
      },
      {
        t: 220,
        type: 'tool',
        id: 't7',
        name: 'Slack Triage',
        status: "Answering 'is this done yet?' x7",
        end: 234,
      },
      { t: 240, type: 'turnEnd', awaitingInput: true },
      {
        t: 290,
        type: 'tool',
        id: 't8',
        name: 'Writing User Story: Dark Mode Toggle',
        status: 'Bribing design team for mockups',
        end: 312,
      },
      {
        t: 330,
        type: 'tool',
        id: 't9',
        name: 'Grep',
        status: "Searching old tickets for 'dark mode' mentions",
        end: 340,
      },
      {
        t: 440,
        type: 'tool',
        id: 't10',
        name: 'Reviewing PR Description',
        status: "Sanity-checking dev-alice's PR against AC",
        end: 456,
      },
      {
        t: 490,
        type: 'tool',
        id: 't11',
        name: 'Stakeholder Sync',
        status: 'Explaining scope creep, again',
        end: 510,
      },
      {
        t: 540,
        type: 'tool',
        id: 't12',
        name: 'Writing User Story: Next Sprint Candidate',
        status: "Queuing up dev-bob's next quest",
        end: 564,
      },
      { t: 590, type: 'sessionEnd', reason: 'end of day' },
    ],
  },
  {
    id: 'dev-alice-01',
    cwd: '/demo/pixel-shop-checkout-service',
    actions: [
      { t: 5, type: 'sessionStart' },
      {
        t: 8,
        type: 'tool',
        id: 'a1',
        name: 'Read',
        status: 'Reading discount-code user story',
        end: 18,
      },
      {
        t: 25,
        type: 'tool',
        id: 'a2',
        name: 'Grep',
        status: 'Searching for existing coupon logic',
        end: 33,
      },
      {
        t: 40,
        type: 'tool',
        id: 'a3',
        name: 'Sketching Approach',
        status: 'Whiteboarding in my head',
        end: 55,
      },
      {
        t: 65,
        type: 'tool',
        id: 'a4',
        name: 'Edit',
        status: 'Adding DiscountCode model',
        end: 100,
      },
      {
        t: 110,
        type: 'tool',
        id: 'a5',
        name: 'Write',
        status: 'Creating discount_service.py',
        end: 150,
      },
      {
        t: 160,
        type: 'tool',
        id: 'a6',
        name: 'Bash',
        status: 'Running pytest -k discount',
        end: 180,
      },
      {
        t: 185,
        type: 'tool',
        id: 'a7',
        name: 'Untangling Test Failure',
        status: 'Why is 10% off becoming -10%...',
        end: 215,
      },
      {
        t: 225,
        type: 'tool',
        id: 'a8',
        name: 'git commit',
        status: 'feat: add percentage-based discount codes',
        end: 233,
      },
      {
        t: 280,
        type: 'tool',
        id: 'a9',
        name: 'Opening PR #142',
        status: 'Writing a PR description nobody will fully read',
        end: 292,
      },
      { t: 293, type: 'subagentStart', parent: 'a9', id: 'a9-sub', name: 'CI Pipeline' },
      { t: 295, type: 'turnEnd', awaitingInput: true },
      { t: 333, type: 'subagentEnd', parent: 'a9', id: 'a9-sub' },
      {
        t: 345,
        type: 'tool',
        id: 'a11',
        name: 'Responding to Review Comments',
        status: 'Fixing the variable name Bob hated',
        end: 370,
      },
      {
        t: 410,
        type: 'tool',
        id: 'a12',
        name: 'Bash',
        status: 'Re-running full test suite before merge',
        end: 432,
      },
      { t: 433, type: 'turnEnd', awaitingInput: false },
      { t: 450, type: 'sessionEnd', reason: 'PR merged, feature shipped' },
    ],
  },
  {
    id: 'dev-bob-01',
    cwd: '/demo/pixel-shop-cart-service',
    actions: [
      { t: 6, type: 'sessionStart' },
      { t: 60, type: 'tool', id: 'b1', name: 'Read', status: 'Reading bug report #891', end: 70 },
      {
        t: 85,
        type: 'tool',
        id: 'b2',
        name: 'Reproducing Bug Locally',
        status: 'Cart says $19.999999999999996',
        end: 105,
      },
      {
        t: 120,
        type: 'tool',
        id: 'b3',
        name: 'Grep',
        status: 'Searching for floating point math in cart.ts',
        end: 132,
      },
      {
        t: 150,
        type: 'tool',
        id: 'b4',
        name: 'Edit',
        status: 'Swapping float math for integer cents',
        end: 195,
      },
      {
        t: 230,
        type: 'tool',
        id: 'b5',
        name: 'Bash',
        status: 'Running npm test -- cart',
        end: 248,
      },
      {
        t: 260,
        type: 'tool',
        id: 'b6',
        name: 'Untangling Merge Conflict in cart.ts',
        status: 'Someone else touched this file too',
        end: 295,
      },
      {
        t: 300,
        type: 'tool',
        id: 'b7',
        name: 'git commit',
        status: 'fix: use integer cents to avoid float rounding',
        end: 308,
      },
      {
        t: 320,
        type: 'tool',
        id: 'b8',
        name: 'Opening PR #143',
        status: 'Bugfix: cart total rounding error',
        end: 330,
      },
      { t: 331, type: 'turnEnd', awaitingInput: true },
      {
        t: 335,
        type: 'tool',
        id: 'b9',
        name: "Reviewing dev-alice's PR #142",
        status: 'Returning the code-review favor',
        end: 355,
      },
      {
        t: 400,
        type: 'tool',
        id: 'b10',
        name: 'Responding to Review Comments',
        status: 'Adding the unit test they asked for',
        end: 428,
      },
      {
        t: 430,
        type: 'tool',
        id: 'b11',
        name: 'WebFetch',
        status: 'Checking IEEE 754 floating point docs, again',
        end: 445,
      },
      { t: 470, type: 'permissionRequest' },
      { t: 480, type: 'turnEnd', awaitingInput: false },
      {
        t: 490,
        type: 'tool',
        id: 'b12',
        name: 'Bash',
        status: 'Deploying hotfix to staging',
        end: 515,
      },
      { t: 520, type: 'sessionEnd', reason: 'hotfix deployed, ticket closed' },
    ],
  },
  {
    id: 'ci-runner',
    cwd: '/workspace/devops-monorepo',
    actions: [
      { t: 1, type: 'sessionStart' },
      { t: 10, type: 'tool', id: 'c1', name: 'Bash', status: 'Tailing CI queue', end: 16 },
      { t: 20, type: 'tool', id: 'c2', name: 'Read', status: 'Reviewing pipeline config', end: 28 },
      { t: 60, type: 'tool', id: 'c3', name: 'Bash', status: 'Warming build cache', end: 70 },
      {
        t: 90,
        type: 'tool',
        id: 'c4',
        name: 'Read',
        status: 'Checking runner disk usage',
        end: 94,
      },
      { t: 140, type: 'turnEnd', awaitingInput: true },
      {
        t: 200,
        type: 'tool',
        id: 'c5',
        name: 'Bash',
        status: 'Pruning old Docker layers',
        end: 212,
      },

      // Pipeline run #1 -- triggered by dev-alice's PR #142.
      {
        t: 322,
        type: 'tool',
        id: 'p1',
        name: 'Pipeline Run',
        status: 'Pipeline Run: alice/feature-discount-codes #142',
        end: 372,
      },
      {
        t: 322,
        type: 'subagentStart',
        parent: 'p1',
        id: 'p1-lint',
        name: 'Lint',
        status: 'Running ESLint + Prettier check',
      },
      {
        t: 323,
        type: 'subagentStart',
        parent: 'p1',
        id: 'p1-unit',
        name: 'Unit Tests',
        status: 'Running Jest suite (1,204 tests)',
      },
      {
        t: 324,
        type: 'subagentStart',
        parent: 'p1',
        id: 'p1-sec',
        name: 'Security Scan',
        status: 'Scanning deps with Trivy',
      },
      {
        t: 327,
        type: 'subagentStart',
        parent: 'p1',
        id: 'p1-docker',
        name: 'Docker Build',
        status: 'Building multi-stage image (amd64/arm64)',
      },
      { t: 330, type: 'subagentEnd', parent: 'p1', id: 'p1-lint' },
      { t: 344, type: 'subagentEnd', parent: 'p1', id: 'p1-unit' },
      { t: 354, type: 'subagentEnd', parent: 'p1', id: 'p1-sec' },
      { t: 372, type: 'subagentEnd', parent: 'p1', id: 'p1-docker' },
      { t: 373, type: 'turnEnd', awaitingInput: false },

      // Pipeline run #2 -- triggered by dev-bob's PR #143 (overlaps run #1).
      {
        t: 342,
        type: 'tool',
        id: 'p2',
        name: 'Pipeline Run',
        status: 'Pipeline Run: bob/hotfix-cart-rounding #143',
        end: 380,
      },
      {
        t: 342,
        type: 'subagentStart',
        parent: 'p2',
        id: 'p2-lint',
        name: 'Lint',
        status: 'Running ESLint + Prettier check',
      },
      {
        t: 343,
        type: 'subagentStart',
        parent: 'p2',
        id: 'p2-unit',
        name: 'Unit Tests',
        status: 'Running Jest suite (targeted: cart/*)',
      },
      {
        t: 344,
        type: 'subagentStart',
        parent: 'p2',
        id: 'p2-sec',
        name: 'Security Scan',
        status: 'Scanning deps with Trivy',
      },
      {
        t: 347,
        type: 'subagentStart',
        parent: 'p2',
        id: 'p2-docker',
        name: 'Docker Build',
        status: 'Building multi-stage image (amd64/arm64)',
      },
      { t: 348, type: 'subagentEnd', parent: 'p2', id: 'p2-lint' },
      { t: 356, type: 'subagentEnd', parent: 'p2', id: 'p2-unit' },
      { t: 362, type: 'subagentEnd', parent: 'p2', id: 'p2-sec' },
      { t: 380, type: 'subagentEnd', parent: 'p2', id: 'p2-docker' },
      { t: 382, type: 'turnEnd', awaitingInput: true },

      {
        t: 480,
        type: 'tool',
        id: 'c6',
        name: 'Grep',
        status: 'Searching for flaky test annotations',
        end: 485,
      },
      { t: 598, type: 'sessionEnd', reason: 'sim complete' },
    ],
  },
  {
    id: 'qa-engineer',
    cwd: '/workspace/devops-monorepo/qa',
    actions: [
      { t: 15, type: 'sessionStart' },
      {
        t: 20,
        type: 'tool',
        id: 'q1',
        name: 'Bash',
        status: 'Spinning up staging environment',
        end: 35,
      },
      {
        t: 45,
        type: 'tool',
        id: 'q2',
        name: 'Read',
        status: 'Reviewing test plan for discount-codes feature',
        end: 55,
      },
      { t: 100, type: 'turnEnd', awaitingInput: true },
      {
        t: 150,
        type: 'tool',
        id: 'q3',
        name: 'Exploratory Testing',
        status: 'Poking around the new discount-code flow',
        end: 175,
      },
      {
        t: 180,
        type: 'tool',
        id: 'q4',
        name: 'Fuzzing checkout API',
        status: 'Fuzzing checkout API with malformed payloads',
        end: 200,
      },
      {
        t: 210,
        type: 'tool',
        id: 'q5',
        name: 'Grep',
        status: 'Grepping logs for stack traces',
        end: 218,
      },
      {
        t: 390,
        type: 'tool',
        id: 'q6',
        name: 'Bash',
        status: 'Running integration suite against staging',
        end: 420,
      },
      {
        t: 421,
        type: 'tool',
        id: 'q7',
        name: 'Chasing a flaky test',
        status: 'Re-running test_cart_rounding 5x',
        end: 439,
      },
      { t: 440, type: 'permissionRequest' },
      {
        t: 458,
        type: 'tool',
        id: 'q8',
        name: 'Manual Triage',
        status: 'Comparing flaky failure against last 10 runs',
        end: 470,
      },
      { t: 471, type: 'turnEnd', awaitingInput: false },
      {
        t: 520,
        type: 'tool',
        id: 'q9',
        name: 'Regression Sweep',
        status: 'Running smoke tests on hotfix build',
        end: 535,
      },
      { t: 597, type: 'sessionEnd', reason: 'sim complete' },
    ],
  },
  {
    id: 'release-mgr',
    cwd: '/workspace/deploy-tools',
    actions: [
      { t: 382, type: 'sessionStart' },
      { t: 383, type: 'tool', id: 'r1', name: 'GitTag', status: 'Tagging v2.4.0-rc1', end: 387 },
      {
        t: 388,
        type: 'tool',
        id: 'r2',
        name: 'ChangelogGen',
        status: 'Compiling changelog from alice+bob commits',
        end: 398,
      },
      {
        t: 399,
        type: 'tool',
        id: 'r3',
        name: 'ArtifactBuild',
        status: 'Building release artifacts',
        end: 413,
      },
      {
        t: 414,
        type: 'tool',
        id: 'r4',
        name: 'StagingDeploy',
        status: 'Deploying to staging',
        end: 426,
      },
      {
        t: 427,
        type: 'tool',
        id: 'r5',
        name: 'SmokeTest',
        status: 'Running staging smoke tests',
        end: 443,
      },
      { t: 444, type: 'turnEnd', awaitingInput: false },
      { t: 445, type: 'permissionRequest' },
      { t: 452, type: 'turnEnd', awaitingInput: true },
      {
        t: 453,
        type: 'tool',
        id: 'r6',
        name: 'ProdDeploy',
        status: 'Deploying v2.4.0 to production',
        end: 473,
      },
      {
        t: 474,
        type: 'tool',
        id: 'r7',
        name: 'DeployVerify',
        status: 'Verifying production rollout',
        end: 482,
      },
      { t: 483, type: 'turnEnd', awaitingInput: false },
      { t: 590, type: 'sessionEnd', reason: 'release day complete' },
    ],
  },
  {
    id: 'sre-oncall',
    cwd: '/workspace/observability',
    actions: [
      { t: 30, type: 'sessionStart' },
      {
        t: 31,
        type: 'tool',
        id: 'o0',
        name: 'DashboardWatch',
        status: 'Watching golden signals dashboard',
        end: 484,
      },
      {
        t: 484,
        type: 'tool',
        id: 'o1',
        name: 'AlertTriage',
        status: 'Checkout latency p99 spiked to 4s',
        end: 490,
      },
      { t: 491, type: 'subagentStart', parent: 'o1', id: 'o1-sub', name: 'Investigating anomaly' },
      {
        t: 492,
        type: 'tool',
        id: 'o2',
        name: 'QueryMetrics',
        status: 'Querying p99 latency by service',
        end: 500,
      },
      {
        t: 501,
        type: 'tool',
        id: 'o3',
        name: 'QueryLogs',
        status: 'Grepping error logs for checkout-service',
        end: 511,
      },
      { t: 512, type: 'subagentEnd', parent: 'o1', id: 'o1-sub' },
      { t: 513, type: 'permissionRequest' },
      { t: 518, type: 'turnEnd', awaitingInput: true },
      {
        t: 519,
        type: 'tool',
        id: 'o4',
        name: 'PageDeveloper',
        status: 'Paging dev-alice -- prod incident',
        end: 522,
      },
      { t: 523, type: 'turnEnd', awaitingInput: true },
      {
        t: 582,
        type: 'tool',
        id: 'o5',
        name: 'WatchRecovery',
        status: 'Watching recovery metrics',
        end: 596,
      },
      {
        t: 597,
        type: 'tool',
        id: 'o6',
        name: 'CloseIncident',
        status: 'Closing incident ticket INC-1042',
        end: 599,
      },
    ],
  },
  {
    // Paged in live by sre-oncall -- a brand-new character spawning mid-simulation.
    id: 'dev-alice-hotfix',
    cwd: '/workspace/checkout-service',
    actions: [
      { t: 524, type: 'sessionStart' },
      {
        t: 525,
        type: 'tool',
        id: 'h1',
        name: 'GitCheckout',
        status: 'Checking out hotfix branch',
        end: 530,
      },
      {
        t: 531,
        type: 'tool',
        id: 'h2',
        name: 'RevertMigration',
        status: 'Reverting migration before it eats someone\u2019s order',
        end: 545,
      },
      {
        t: 546,
        type: 'tool',
        id: 'h3',
        name: 'RunTests',
        status: 'Running regression tests on checkout',
        end: 558,
      },
      { t: 559, type: 'turnEnd', awaitingInput: false },
      {
        t: 560,
        type: 'tool',
        id: 'h4',
        name: 'DeployHotfix',
        status: 'Deploying hotfix to production',
        end: 576,
      },
      { t: 577, type: 'turnEnd', awaitingInput: false },
      { t: 578, type: 'sessionEnd', reason: 'hotfix deployed, session complete' },
    ],
  },
];

// ── Translate story actions into wire events ─────────────────────────────

/** @typedef {{t:number, sessionId:string, cwd:string, event:Record<string, unknown>}} WireEvent */

/** @returns {WireEvent[]} */
function buildEvents() {
  /** @type {WireEvent[]} */
  const events = [];
  for (const agent of AGENTS) {
    for (const action of agent.actions) {
      const base = { sessionId: agent.id, cwd: agent.cwd };
      switch (action.type) {
        case 'sessionStart':
          events.push({
            t: action.t,
            ...base,
            event: { hook_event_name: 'sessionStart', cwd: agent.cwd },
          });
          break;
        case 'tool':
          events.push({
            t: action.t,
            ...base,
            event: {
              hook_event_name: 'toolStart',
              tool_id: action.id,
              tool_name: action.name,
              status: action.status,
            },
          });
          events.push({
            t: action.end,
            ...base,
            event: { hook_event_name: 'toolEnd', tool_id: action.id },
          });
          break;
        case 'subagentStart':
          events.push({
            t: action.t,
            ...base,
            event: {
              hook_event_name: 'subagentStart',
              parent_tool_id: action.parent,
              tool_id: action.id,
              tool_name: action.name,
              ...(action.status ? { status: action.status } : {}),
            },
          });
          break;
        case 'subagentEnd':
          events.push({
            t: action.t,
            ...base,
            event: {
              hook_event_name: 'subagentEnd',
              parent_tool_id: action.parent,
              tool_id: action.id,
            },
          });
          break;
        case 'permissionRequest':
          events.push({ t: action.t, ...base, event: { hook_event_name: 'permissionRequest' } });
          break;
        case 'turnEnd':
          events.push({
            t: action.t,
            ...base,
            event: { hook_event_name: 'turnEnd', awaiting_input: action.awaitingInput === true },
          });
          break;
        case 'sessionEnd':
          events.push({
            t: action.t,
            ...base,
            event: { hook_event_name: 'sessionEnd', reason: action.reason },
          });
          break;
        default:
          throw new Error(`Unknown action type: ${action.type}`);
      }
    }
  }
  events.sort((a, b) => a.t - b.t);
  return events;
}

// ── Server discovery (mirrors scripts/web-agent.sh) ──────────────────────

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

async function postEvent(config, sessionId, event) {
  const body = { session_id: sessionId, ...event };
  if (DRY_RUN) return;
  const response = await fetch(`http://127.0.0.1:${config.port}/api/hooks/web`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    console.error(`  ! HTTP ${response.status} for ${sessionId} ${event.hook_event_name}: ${text}`);
  }
}

// ── Narration ─────────────────────────────────────────────────────────

function describe(event) {
  switch (event.hook_event_name) {
    case 'sessionStart':
      return 'walks into the office';
    case 'toolStart':
      return `${event.tool_name}${event.status ? ` -- "${event.status}"` : ''}`;
    case 'toolEnd':
      return 'finished a task';
    case 'subagentStart':
      return `spawns sub-task "${event.tool_name}"`;
    case 'subagentEnd':
      return 'sub-task done';
    case 'permissionRequest':
      return 'needs approval';
    case 'turnEnd':
      return event.awaiting_input ? 'waiting for input' : 'done for now';
    case 'sessionEnd':
      return `leaves the office (${event.reason ?? 'session end'})`;
    default:
      return event.hook_event_name;
  }
}

// ── Scheduler ────────────────────────────────────────────────────────────

async function main() {
  const events = buildEvents();
  const totalSeconds = Math.max(...events.map((e) => e.t));
  const config = DRY_RUN ? null : readServerConfig();

  console.log('');
  console.log('=== Pixel Agents: a day in the life of a DevOps team ===');
  console.log(
    `${AGENTS.length} agents, ${events.length} events, ${totalSeconds}s of story compressed to ${(totalSeconds / SPEED).toFixed(0)}s (speed x${SPEED}).`,
  );
  if (DRY_RUN) console.log('(dry run -- printing events, not sending them)');
  else console.log(`Posting to http://127.0.0.1:${config.port}/api/hooks/web`);
  console.log('');

  const startedAt = Date.now();
  const timers = events.map((e) =>
    setTimeout(
      async () => {
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
        console.log(
          `[t=${String(e.t).padStart(3, ' ')}s / +${elapsed}s] ${e.sessionId}: ${describe(e.event)}`,
        );
        try {
          await postEvent(config, e.sessionId, e.event);
        } catch (err) {
          console.error(`  ! failed to send event for ${e.sessionId}: ${err.message}`);
        }
      },
      (e.t * 1000) / SPEED,
    ),
  );

  process.on('SIGINT', () => {
    console.log('\nInterrupted -- clearing remaining scheduled events.');
    for (const timer of timers) clearTimeout(timer);
    process.exit(130);
  });

  await new Promise((resolve) => setTimeout(resolve, (totalSeconds * 1000) / SPEED + 500));
  console.log('');
  console.log('=== Simulation complete. ===');
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
