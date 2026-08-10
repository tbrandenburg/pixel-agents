/**
 * Disclosure text for the hooks consent gate. Both surfaces show the SAME
 * in-app dialog: the server ships these strings in the `hooksConsentRequest`
 * message and the webview's ConsentModal renders them verbatim, so there is
 * exactly one copy of the terms and no client-side duplicate to drift into
 * asking for approval on weaker terms.
 *
 * Two pieces: the HEADLINE is the dialog's title and the DISCLOSURE is its
 * body. Every disclosure fact lives in one or the other, never in a surface's
 * own copy.
 *
 * The event count is interpolated from CLAUDE_HOOK_EVENTS, never written out:
 * a hardcoded number silently becomes a lie the next time the list changes.
 */

import { CLAUDE_HOOK_EVENTS, SETTINGS_BACKUP_SUFFIX } from './constants.js';

const SETTINGS_FILE = '~/.claude/settings.json';

/** WHAT we write. */
export const CONSENT_FACT_WHAT =
  `This adds hook entries for ${CLAUDE_HOOK_EVENTS.length} Claude Code events to ${SETTINGS_FILE}. ` +
  `Your existing settings are kept, and a one-time backup is saved next to them as settings.json${SETTINGS_BACKUP_SUFFIX}.`;

/** WHAT data moves, and where it stops.
 *
 *  "Nothing leaves your machine" used to be the second sentence, and it is not
 *  something this prompt can promise: `npx pixel-agents --host 0.0.0.0` binds
 *  the same server to every interface, and an accepted socket receives the
 *  store broadcasts (server/src/httpServer.ts). The claim was true for the
 *  default and false for a documented flag — so it states the default and names
 *  the one thing that changes it, rather than making a promise the software can
 *  be asked to break. */
export const CONSENT_FACT_DATA =
  'Claude Code will send those events - including tool names and tool inputs - to a Pixel Agents ' +
  'server on this machine. It is not sent anywhere else: by default the server listens on ' +
  '127.0.0.1 only, reachable from this machine alone (note that starting it with --host exposes it to your ' +
  'network).';

/** HOW to undo it. */
export const CONSENT_FACT_REVERSIBLE =
  'You can remove the hooks at any time from Settings → Instant Detection (Hooks).';

/** Headline for the first-run gate — the only population that is asked. A user
 *  whose hooks a pre-consent version already installed is migrated silently
 *  (the migration only ever drops events), so there is no second headline. */
export const CONSENT_INSTALL_HEADLINE =
  'To show your agents in real time, Pixel Agents needs to add its hooks to ~/.claude/settings.json.';

/** The three disclosure facts, in order, as one block.
 *
 *  This is the dialog's body. The ConsentModal splits it on the blank lines
 *  and renders every paragraph in full on the decision surface itself — no
 *  "Details" affordance, which would put the disclosure one click away from
 *  the decision it is there to inform. */
export const CONSENT_DISCLOSURE = [
  CONSENT_FACT_WHAT,
  CONSENT_FACT_DATA,
  CONSENT_FACT_REVERSIBLE,
].join('\n\n');
