/**
 * Carrying out a consent answer — the half of the gate that touches disk.
 *
 * `consentGate.ts` decides WHAT an answer means; this decides nothing and only
 * performs it. Both live here rather than once per surface for the same
 * reason: the two copies had already diverged once, and centralizing only the
 * policy left the five-arm execution duplicated one layer down, where the same
 * drift could happen again with the same consequence (`~/.claude/settings.json`
 * on the other side of it).
 *
 * What differs between the surfaces is only HOW each effect is carried out —
 * VS Code raises an error modal and writes a workspace setting, standalone
 * logs and writes through the store's adapter — so the surfaces supply
 * `ConsentEffects` and share everything else, including the ORDER of the
 * writes, which is the part that strands users when it is wrong.
 */

import { readConfig, revokeHooksConsent } from '../../../configPersistence.js';
import { consentActionFor } from './consentGate.js';

/** The per-surface half of carrying out an answer. Each method is the surface's
 *  existing path, not a new one written for consent: the whole point is that a
 *  consent answer and the Settings toggle take the SAME route. */
export interface ConsentEffects {
  /** The full Settings-toggle path: install or uninstall, then persist the
   *  preference only when the resulting on-disk state agrees, then report it. */
  setHooksEnabled(enabled: boolean): Promise<void>;
  /** Uninstall WITHOUT touching the persisted preference. Surfaces its own
   *  failure to the user; never throws. */
  uninstallHooks(): Promise<void>;
  /** Read the on-disk truth. Never throws — an unreadable settings.json
   *  resolves to the value the caller passes as its fallback. */
  areHooksInstalled(): Promise<boolean>;
  /** Persist hooks-off without going near settings.json. */
  persistHooksOff(): void;
  /** Broadcast the re-derived install state to the webview. */
  reportHooksStatus(): Promise<void>;
}

/**
 * One answer at a time, per process.
 *
 * The Intro is DESIGNED to produce two answers in quick succession — walking
 * Back from the closing step and revising is the whole reason a choice is read
 * as absolute state. Both surfaces dispatch the response without awaiting it,
 * and every action below re-reads the disk to decide what it means, so an
 * unserialized revision could observe the first answer's install mid-flight,
 * read `installed: false`, and degrade `notNow`/`never` into their no-op
 * variants — leaving hooks installed against the user's final answer.
 *
 * This orders answers within one process, which is where the Back-and-revise
 * race lives. Two separate windows racing each other is a different problem
 * (no shared lock over settings.json); the installer's re-read-before-rename
 * is what narrows that one.
 */
let consentQueue: Promise<void> = Promise.resolve();

/**
 * Act on a `hooksConsentResponse`, after everything ahead of it has settled.
 *
 * The install state is read fresh at the head of the action, never captured
 * when the message arrived: the Intro lets the user REVISE, and what a decline
 * means depends on what the previous answer actually left on disk.
 */
export function applyConsentChoice(choice: unknown, effects: ConsentEffects): Promise<void> {
  const next = consentQueue.then(() => runConsentChoice(choice, effects));
  // The queue must survive a rejected action, or one failure blocks every
  // later answer. The rejection still reaches this call's own caller.
  consentQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function runConsentChoice(choice: unknown, effects: ConsentEffects): Promise<void> {
  // Fail closed: an unreadable settings.json reads as "nothing of ours is
  // installed", which maps every choice to its no-file-touch variant. We never
  // uninstall on a guess.
  const installed = await effects.areHooksInstalled().catch(() => false);
  const consentGiven = readConfig().hooksConsentGiven;

  switch (consentActionFor(choice, { installed, consentGiven })) {
    case 'install':
      // Clicking Install IS the consent grant, exactly like the Settings
      // toggle — so it takes that same path, which grants, installs, then
      // re-derives the on-disk state before persisting the preference.
      // Reimplementing the grant here is how the VS Code copy once lost that
      // last step.
      await effects.setHooksEnabled(true);
      break;

    case 'disable':
      // A revised "never" over a landed install: the full toggle-off path —
      // uninstall first, persist hooks-off only once the disk agrees.
      await effects.setHooksEnabled(false);
      break;

    case 'revert': {
      // A revised "not now": undo what the earlier answer left, leaving the
      // hooks PREFERENCE alone and revoking the grant instead — "not now" must
      // leave the world exactly as if never answered, so the ask comes back on
      // the next open.
      if (installed) {
        await effects.uninstallHooks();
        // Revoke only once the removal verifiably landed; an unreadable file
        // resolves to "still there", which keeps the grant and leaves the
        // Settings toggle as the removal route.
        if (!(await effects.areHooksInstalled().catch(() => true))) revokeHooksConsent();
        console.log('[Pixel Agents] Hook install undone — you will be asked again next time.');
      } else {
        // Nothing of ours on disk: the grant is all the earlier answer left
        // (an Install that was recorded and then failed to write). There is
        // nothing to uninstall and no settings.json read that could go wrong —
        // revoking is a config.json write of our own, so it is unconditional.
        revokeHooksConsent();
        console.log('[Pixel Agents] Hook approval withdrawn — you will be asked again next time.');
      }
      await effects.reportHooksStatus();
      break;
    }

    case 'persistOff':
      // Persist hooks-off WITHOUT touching ~/.claude/settings.json — with
      // nothing of ours installed there is nothing to remove, and routing
      // through the uninstaller would surface a file error for the act of
      // declining.
      effects.persistHooksOff();
      console.log('[Pixel Agents] Hooks disabled. Re-enable them any time in the UI settings.');
      await effects.reportHooksStatus();
      break;

    case 'none':
      // Writes nothing; the ask fires again on the next webviewReady. Reached
      // by a first "Not Now" (nothing to undo) and by every junk value, which
      // is why the line claims no more than that nothing was installed.
      console.log(
        '[Pixel Agents] Skipping hook install for this run — you will be asked again next time.',
      );
      break;
  }
}
