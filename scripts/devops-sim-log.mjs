/**
 * Shared logging helpers for the DevOps simulation scripts
 * (simulate-devops-day.mjs, simulate-devops-loop.mjs), matching the
 * project's own console logging convention: a bracketed context tag prefix
 * on every line (see CLAUDE.md's "Logging" section -- `[Pixel Agents]`,
 * `[AssetLoader]`, `[Webview]`, etc.). These scripts use `[Pixel Agents Sim]`
 * as their tag, the same pattern applied to a new context.
 */

export const LOG_PREFIX = '[Pixel Agents Sim]';

/** Startup banner -- printed once, matches server.ts's own startup banner style. */
export function banner(lines) {
  console.log('');
  for (const line of lines) console.log(`${LOG_PREFIX} ${line}`);
  console.log('');
}

export function describeEvent(event) {
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

/** One line per event, e.g. `[Pixel Agents Sim] [+12.3s] dev-alice-1: Read -- "..."` */
export function logEvent(elapsedSeconds, sessionId, event) {
  console.log(`${LOG_PREFIX} [+${elapsedSeconds}s] ${sessionId}: ${describeEvent(event)}`);
}

export function logWarn(message) {
  console.warn(`${LOG_PREFIX} ${message}`);
}

export function logError(message) {
  console.error(`${LOG_PREFIX} ${message}`);
}

/**
 * Periodic "still alive" heartbeat -- independent of the simulation's own
 * event traffic, so a quiet stretch (nobody currently mid-tool-call) never
 * reads as "did this hang?". `statsFn` returns the line to print each tick.
 */
export function startHeartbeat(intervalMs, statsFn) {
  const timer = setInterval(() => {
    console.log(`${LOG_PREFIX} ${statsFn()}`);
  }, intervalMs);
  timer.unref?.();
  return timer;
}
