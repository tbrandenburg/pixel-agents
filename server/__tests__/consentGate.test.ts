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
  it('installs on an exact install', () => {
    expect(consentActionFor('install')).toBe('install');
  });

  it('persists hooks-off on an exact never', () => {
    expect(consentActionFor('never')).toBe('persistOff');
  });

  // notNow and every unrecognized value are the SAME action: write nothing and
  // ask again. Junk must never be read as approval — or as a durable decline,
  // which would silently retire the ask on a malformed message.
  it.each([
    'notNow',
    'yes',
    'y',
    '',
    'Install',
    'INSTALL',
    'installl',
    'not-now',
    'NEVER',
    'never ',
    42,
    true,
    null,
    undefined,
    {},
    ['install'],
  ])('writes nothing for %j', (junk) => {
    expect(consentActionFor(junk)).toBe('none');
  });
});
