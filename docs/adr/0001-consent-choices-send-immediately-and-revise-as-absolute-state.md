# Consent choices send immediately, and a revised choice is an absolute state command

The Intro wraps the first-run hooks consent ask in a four-step tour whose closing step
has a Back button, so an already-answered ask can be re-answered. We decided that a
consent-step click sends its `hooksConsentResponse` the moment it happens (no deferred
commit on "Let's Go"), and that the server therefore reads every choice as a statement
of the state the user wants _now_, against the current on-disk install state: a
revised "Don't Ask Again" over a landed install takes the full Settings toggle-off
path (uninstall, then persist hooks-off once the disk agrees), and a revised "Not Now"
reverts the install entirely (uninstall plus `revokeHooksConsent()`, preference
untouched, so the ask genuinely returns).

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

- `consentActionFor(choice, installed)` is state-aware; callers pass fresh
  `areHooksInstalled()` and degrade an unreadable settings file to `installed: false`,
  so no choice ever uninstalls on a guess.
- The webview must keep the tour mounted after its own choice: the install's
  `hooksStatus installed: true` broadcast moots an _unanswered_ ask but must not yank
  the closing step from the person who just answered (App snapshots the request and
  gates the moot on a sent choice).
