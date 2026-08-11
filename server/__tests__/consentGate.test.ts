import { describe, expect, it } from 'vitest';

import {
  CONSENT_DISCLOSURE,
  CONSENT_INSTALL_HEADLINE,
} from '../src/providers/hook/claude/consentCopy.js';
import { consentActionFor, hooksConsentRequest } from '../src/providers/hook/claude/consentGate.js';

/**
 * consentGate is the ONE place both surfaces decide whether to ask for hooks
 * consent and what an answer means. It exists because the VS Code adapter and
 * the standalone handler used to carry a copy each, and the copies drifted:
 * one routed Install through the persist-after-settle path and the other did
 * not. These tests pin the policy itself, so a surface that reimplements it
 * has something to fail against.
 *
 * The behaviour reached THROUGH each surface stays pinned where it was —
 * clientMessageHandler.test.ts for standalone, consent.spec.ts for VS Code.
 */
describe('hooksConsentRequest — when to ask', () => {
  const askable = {
    installed: false,
    hooksEnabled: true,
    consentGiven: false,
    privileged: true,
  };

  it('asks the one population with nothing of ours installed', () => {
    expect(hooksConsentRequest(askable)).toEqual({
      type: 'hooksConsentRequest',
      headline: CONSENT_INSTALL_HEADLINE,
      disclosure: CONSENT_DISCLOSURE,
    });
  });

  // The payload carries the server's copy so the webview renders the exact
  // terms being approved. A client-side duplicate is the failure this guards.
  it('ships the shared disclosure, not a summary of it', () => {
    const request = hooksConsentRequest(askable);
    expect(request?.disclosure).toBe(CONSENT_DISCLOSURE);
    expect(request?.disclosure).toContain('~/.claude/settings.json');
  });

  // Each of these is a reason the ask would be wrong, not merely redundant.
  it.each([
    ['our hooks are already installed', { installed: true }],
    ['consent was already recorded', { consentGiven: true }],
    ['the user turned hooks off', { hooksEnabled: false }],
    ['the client could not act on an answer', { privileged: false }],
  ])('does not ask when %s', (_why, override) => {
    expect(hooksConsentRequest({ ...askable, ...override })).toBeNull();
  });

  // An untokened standalone spectator's hooksConsentResponse is dropped by the
  // handler, so showing it the dialog would be asking a question whose answer
  // is discarded. The privilege check gates the ASK, not just the response.
  it('never asks an unprivileged client, even when everything else lines up', () => {
    expect(hooksConsentRequest({ ...askable, privileged: false })).toBeNull();
  });
});

describe('consentActionFor — what an answer means', () => {
  // The Intro lets the user walk back from the closing step and revise an
  // already-sent answer, so a choice is an absolute statement of desired
  // state: what a decline maps to depends on whether our hooks are on disk
  // right now (they are exactly when an earlier Install landed).
  it('installs on an exact install, whether or not hooks are on disk', () => {
    expect(consentActionFor('install', false)).toBe('install');
    expect(consentActionFor('install', true)).toBe('install');
  });

  it('persists hooks-off on an exact never with nothing installed', () => {
    expect(consentActionFor('never', false)).toBe('persistOff');
  });

  // A revised "never" over a landed install must remove the hooks, not merely
  // record a preference beside them — a persisted hooks-off over live entries
  // is the stranding bug: entries firing, checkbox lying, gate skipped.
  it('takes the full toggle-off path on a never over a landed install', () => {
    expect(consentActionFor('never', true)).toBe('disable');
  });

  it('writes nothing on a notNow with nothing installed', () => {
    expect(consentActionFor('notNow', false)).toBe('none');
  });

  // A revised "not now" over a landed install must leave the world exactly as
  // if never answered: uninstall AND revoke the recorded grant, so the ask
  // genuinely comes back on the next open.
  it('reverts the install on a notNow over a landed install', () => {
    expect(consentActionFor('notNow', true)).toBe('revert');
  });

  // Every unrecognized value writes nothing — installed or not. Junk must
  // never be read as approval, as a durable decline (which would silently
  // retire the ask on a malformed message), or as an uninstall trigger.
  it.each([
    'yes',
    'y',
    '',
    'Install',
    'INSTALL',
    'installl',
    'not-now',
    'notnow',
    'NEVER',
    'never ',
    42,
    true,
    null,
    undefined,
    {},
    ['install'],
  ])('writes nothing for %j', (junk) => {
    expect(consentActionFor(junk, false)).toBe('none');
    expect(consentActionFor(junk, true)).toBe('none');
  });
});
