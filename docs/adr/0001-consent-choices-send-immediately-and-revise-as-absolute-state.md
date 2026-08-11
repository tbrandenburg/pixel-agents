# Consent choices send immediately, and a revised choice is an absolute state command

The Intro wraps the first-run hooks consent ask in a four-step tour whose closing step
has a Back button, so an already-answered ask can be re-answered. We decided that a
consent-step click sends its `hooksConsentResponse` the moment it happens (no deferred
commit on "Let's Go"), and that the server therefore reads every choice as a statement
of the state the user wants _now_, against everything an earlier answer left behind: a
revised "Don't Ask Again" over a landed install takes the full Settings toggle-off
path (uninstall, then persist hooks-off once the disk agrees), and a revised "Not Now"
reverts the install entirely (uninstall plus `revokeHooksConsent()`, preference
untouched, so the ask genuinely returns).

"Everything an earlier answer left behind" is deliberately broader than "our hooks are
on disk". `install` records the consent grant _before_ it writes, so an install that
then failed — the unparseable `settings.json` of issue #377, exactly the population
this whole gate exists for — leaves a grant with nothing on disk. The grant alone is
what retires the ask, so a revert keyed on the install state read that as "nothing to
undo" and left the user with an ask that could never come back. The state a revision is
read against is therefore `{ installed, consentGiven }`, and revoking a grant with
nothing installed touches no user file at all.

## Considered options

- **Deferred commit** — record the choice locally and send once, at "Let's Go". Keeps
  the one-answer-per-ask invariant by construction and needs no revision semantics.
  Rejected: a user who clicks Install and then closes the tour with the close x (or loses
  the window) would have their explicit decision silently discarded.
- **Immediate send with one-shot semantics** (the pre-Intro rule, unchanged) —
  rejected because replaying `never → persist hooks-off, touch nothing` after an
  install recreates the stranding bug this codebase already fixed once: entries live
  on disk and firing behind a persisted hooks-off, checkbox lying, gate skipped
  forever.

## Consequences

- `consentActionFor(choice, { installed, consentGiven })` is state-aware; callers pass
  fresh `areHooksInstalled()` and degrade an unreadable settings file to
  `installed: false`, so no choice ever uninstalls on a guess.
- Answers must be **serialized**. Revision is the whole point of this decision, so two
  answers in quick succession are a designed-for case, not an edge one — and both
  surfaces dispatch them without awaiting. An unserialized revision can observe the
  first answer's install mid-flight, read `installed: false`, and degrade into its
  no-op variant, leaving hooks installed against the user's final answer.
  `consentExecutor.ts` holds one queue per process, which is where the
  Back-and-revise race lives; two separate windows racing is a different problem, and
  the installer's re-read-before-rename is what narrows that one.
- The webview must keep the tour mounted after its own choice: the install's
  `hooksStatus installed: true` broadcast moots an _unanswered_ ask but must not yank
  the closing step from the person who just answered (App snapshots the request and
  gates the moot on a sent choice).
- The closing step reports the **outcome**, not the click. An install can fail for
  reasons unrelated to the answer, and a tour that congratulates regardless leaves the
  user believing hooks are running over a file that was never written. The App settles
  the verdict on the ARRIVAL of a `hooksStatus` (`hooksStatusSeq`), because a failed
  install re-reports the same `false` the webview already held — the value never
  changes, only the message arrives.
