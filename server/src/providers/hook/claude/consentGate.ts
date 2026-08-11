/**
 * The first-run hooks consent POLICY: when to ask, and what an answer means.
 *
 * Both surfaces ask the same question through the same in-app dialog, so both
 * must decide to ask on the same terms and read the answer on the same terms.
 * Written once here rather than once per surface, because the two halves of a
 * duplicated gate drift silently and the thing on the other side of this gate
 * is `~/.claude/settings.json`.
 *
 * The copy itself lives in consentCopy.ts; this module decides whether it is
 * sent and what comes back.
 */

import type { HooksConsentRequest } from '../../../../../core/src/messages.js';
import { CONSENT_DISCLOSURE, CONSENT_INSTALL_HEADLINE } from './consentCopy.js';

/** Inputs to the ask-or-not decision, as each surface already knows them. */
export interface ConsentGateState {
  /** Are any of OUR hook commands on disk right now (areHooksInstalled)? */
  installed: boolean;
  /** The persisted hooks preference. Defaults true, so it is only false after
   *  an explicit decline or a Settings toggle-off. */
  hooksEnabled: boolean;
  /** Has consent already been recorded (config.json hooksConsentGiven)? */
  consentGiven: boolean;
  /** May this client's answer actually be acted on? Embedded webviews are
   *  privileged by construction; a standalone connection must have proved the
   *  server token. Showing the dialog to a client whose answer would be
   *  ignored is a lie, so it gates the ASK and not just the response. */
  privileged: boolean;
}

/**
 * The `hooksConsentRequest` to send during a `webviewReady` handshake, or null
 * when this client must not be asked.
 *
 * Every condition is a reason NOT to ask:
 *  - already installed → there is nothing to approve (and the pre-consent
 *    migration population is granted silently at startup, so it lands here).
 *  - consent recorded → asked and answered, once, forever.
 *  - hooks preference off → a previous "Don't Ask Again" (or Settings
 *    toggle-off); re-asking would make the decline meaningless.
 *  - unprivileged → its answer would be dropped.
 */
export function hooksConsentRequest(state: ConsentGateState): HooksConsentRequest | null {
  if (state.installed || state.consentGiven || !state.hooksEnabled || !state.privileged) {
    return null;
  }
  return {
    type: 'hooksConsentRequest',
    headline: CONSENT_INSTALL_HEADLINE,
    disclosure: CONSENT_DISCLOSURE,
  };
}

/** What the server should DO about an answer.
 *
 *  The Intro lets the user walk BACK from the closing step and change an
 *  already-sent answer, so a choice is an absolute statement of the state the
 *  user wants — not a one-shot event. Which action a decline maps to therefore
 *  depends on what the earlier answer already LEFT BEHIND: our hooks on disk,
 *  a recorded consent grant, or both.
 *
 *  - `install`: grant consent and install, the same path as the Settings
 *    toggle. Idempotent, so a repeated install is safe.
 *  - `persistOff` (never, nothing installed): persist hooks-off and write
 *    nothing to settings.json — there is nothing to remove and no reason to
 *    touch the file (or to fail on an unparseable one while merely declining).
 *    A grant left over from a failed install may stay: hooks-off retires the
 *    ask on its own, and re-enabling from Settings is itself a fresh grant.
 *  - `disable` (never, ours installed): the full Settings toggle-off path —
 *    uninstall, then persist hooks-off only after the on-disk result agrees.
 *    Without this, a revised "never" would leave live hooks behind a
 *    persisted hooks-off: entries firing, checkbox lying, gate skipped.
 *  - `revert` (notNow, over anything an earlier answer left): undo it and
 *    revoke the consent grant, leaving the hooks preference alone — "not now"
 *    means the ask should come back, and a recorded grant would silently
 *    retire it forever.
 *  - `none` (notNow with nothing to undo — and every junk value): write
 *    nothing at all; the ask fires again on the next connect. */
export type ConsentAction = 'install' | 'persistOff' | 'disable' | 'revert' | 'none';

/** What an earlier answer may have left behind, as the surface reads it when
 *  the next answer arrives. */
export interface ConsentRevisionState {
  /** Are any of OUR hook commands on disk right now (areHooksInstalled)?
   *  Callers that cannot read it pass false — the file is then never touched
   *  on a guess. */
  installed: boolean;
  /** Has a grant been recorded (config.json hooksConsentGiven)? Read
   *  SEPARATELY from `installed` because `install` grants BEFORE it writes: an
   *  install that then failed leaves a grant with nothing on disk, and that
   *  grant is what retires the ask. Keying the revert off `installed` alone
   *  stranded exactly that user — the ask never came back. */
  consentGiven: boolean;
}

/**
 * Fail-closed on exact matches. Only the literal `'install'` approves and only
 * the literal `'never'` declines durably; `'notNow'`, a dismissal that sends
 * nothing, a truncated payload, and any value a crafted message could carry
 * all fall through to the no-write actions.
 *
 * `unknown` is the honest parameter type for `choice`: this runs on a wire
 * message, and narrowing it here is the point of the function.
 */
export function consentActionFor(choice: unknown, state: ConsentRevisionState): ConsentAction {
  if (choice === 'install') return 'install';
  if (choice === 'never') return state.installed ? 'disable' : 'persistOff';
  if (choice === 'notNow') return state.installed || state.consentGiven ? 'revert' : 'none';
  return 'none';
}
