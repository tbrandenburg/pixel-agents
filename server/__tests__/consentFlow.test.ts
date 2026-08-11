import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { type ClientMessageContext, handleClientMessage } from '../src/clientMessageHandler.js';
import { grantHooksConsent, readConfig } from '../src/configPersistence.js';
import { FileStateAdapter } from '../src/fileStateAdapter.js';
import {
  CONSENT_DISCLOSURE,
  CONSENT_INSTALL_HEADLINE,
} from '../src/providers/hook/claude/consentCopy.js';
import { CLAUDE_HOOK_EVENTS } from '../src/providers/hook/claude/constants.js';

/** Let a dispatch's async chain (side effect → areHooksInstalled → persist →
 *  send) run to completion. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

/**
 * The in-app first-run consent flow, driven through the standalone dispatch
 * (clientMessageHandler): the server asks over the wire (hooksConsentRequest
 * during the webviewReady handshake) and acts on the answer
 * (hooksConsentResponse) via the shared consent modules (consentGate decides,
 * consentExecutor performs). These translate the semantics the retired TTY
 * prompt pinned in cli.test.ts — most importantly that nothing but an exact,
 * explicit approval ever installs, and that junk is never read as one.
 */
describe('clientMessageHandler: hooks consent flow', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let store: AgentStateStore;
  let sent: Array<Record<string, unknown>>;
  let ctx: ClientMessageContext;

  /** Put our command on every installed event, as a real install would. */
  function seedInstalledHooks(): void {
    const command = `node "${path.join(tempHome, '.pixel-agents', 'hooks', 'claude-hook.js')}"`;
    const entry = { matcher: '', hooks: [{ type: 'command', command, timeout: 5 }] };
    fs.mkdirSync(path.join(tempHome, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(tempHome, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: Object.fromEntries(CLAUDE_HOOK_EVENTS.map((e) => [e, [entry]])),
      }),
    );
  }

  function consentGiven(): boolean {
    return readConfig().hooksConsentGiven === true;
  }

  function settingsJsonExists(): boolean {
    return fs.existsSync(path.join(tempHome, '.claude', 'settings.json'));
  }

  /** The strongest possible "writes nothing": the config file was never even
   *  created. (getSetting can't probe for an absent key — the adapter resolves
   *  settings through readConfig's schema defaults, hooksEnabled=true among
   *  them, so an unset key is indistinguishable from a persisted default.) */
  function configJsonExists(): boolean {
    return fs.existsSync(path.join(tempHome, '.pixel-agents', 'config.json'));
  }

  async function connect(): Promise<void> {
    handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);
    await settle(); // the request rides the async areHooksInstalled follow-up
  }

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-consent-flow-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;

    store = new AgentStateStore();
    store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
    sent = [];
    ctx = { store, cache: null, privileged: true };
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    store.dispose();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  // ── hooksConsentRequest: who is asked, and on what terms ─────

  describe('hooksConsentRequest on webviewReady', () => {
    // The request carries the server's exact disclosure so the dialog cannot
    // render weaker terms than the ones consentCopy.test.ts pins.
    it('asks a privileged connection, carrying the shared disclosure verbatim', async () => {
      await connect();

      const request = sent.find((m) => m.type === 'hooksConsentRequest');
      expect(request).toEqual({
        type: 'hooksConsentRequest',
        headline: CONSENT_INSTALL_HEADLINE,
        disclosure: CONSENT_DISCLOSURE,
      });
      // After the truthful install state, never before: the webview treats
      // hooksStatus installed=true as "the ask is moot", so a request sent
      // ahead of the status it depends on could be closed by its own handshake.
      const types = sent.map((m) => m.type);
      expect(types.indexOf('hooksStatus')).toBeLessThan(types.indexOf('hooksConsentRequest'));
    });

    // A spectator's answer would be ignored (below), so showing it the dialog
    // would be a lie.
    it('never asks an unprivileged connection', async () => {
      ctx.privileged = false;
      await connect();

      expect(sent.find((m) => m.type === 'hooksConsentRequest')).toBeUndefined();
    });

    it('never asks once consent is recorded', async () => {
      grantHooksConsent();
      await connect();

      expect(sent.find((m) => m.type === 'hooksConsentRequest')).toBeUndefined();
    });

    // The silent-grant population (a pre-consent version's install, migrated at
    // startup): exactly one population is prompted — the one with NOTHING of
    // ours installed.
    it('never asks while our hooks are already installed', async () => {
      seedInstalledHooks();
      await connect();

      expect(sent.find((m) => m.type === 'hooksConsentRequest')).toBeUndefined();
    });

    it('never asks while the hooks preference is off', async () => {
      store.getAdapter()!.setSetting('pixel-agents.hooksEnabled', false);
      await connect();

      expect(sent.find((m) => m.type === 'hooksConsentRequest')).toBeUndefined();
    });

    // Not-now writes nothing, so the gate must still be open on the next
    // connect — the re-ask is what makes dismissal safe to fail closed.
    it('asks again on the next connect after a notNow', async () => {
      await connect();
      handleClientMessage(
        { type: 'hooksConsentResponse', choice: 'notNow' },
        (m) => sent.push(m),
        ctx,
      );
      await settle();
      sent = [];

      await connect();
      expect(sent.find((m) => m.type === 'hooksConsentRequest')).toBeDefined();
    });
  });

  // ── hooksConsentResponse: what each answer writes ────────────

  describe('hooksConsentResponse', () => {
    it('install runs the install side effect and persists the preference on success', async () => {
      let sideEffectEnabled: boolean | undefined;
      ctx.onSetHooksEnabled = (enabled) => {
        sideEffectEnabled = enabled;
        seedInstalledHooks(); // the install landed
      };

      handleClientMessage(
        { type: 'hooksConsentResponse', choice: 'install' },
        (m) => sent.push(m),
        ctx,
      );
      await settle();

      expect(sideEffectEnabled).toBe(true);
      expect(store.getAdapter()!.getSetting('pixel-agents.hooksEnabled', false)).toBe(true);
      expect(sent.find((m) => m.type === 'hooksStatus')).toEqual({
        type: 'hooksStatus',
        installed: true,
      });
    });

    // Same stranding rule as the Settings toggle: intent is never persisted
    // over an outcome that disagrees with it.
    it('install does not persist hooks-on when the install failed', async () => {
      store.getAdapter()!.setSetting('pixel-agents.hooksEnabled', false);
      ctx.onSetHooksEnabled = () => {
        /* the install failed: settings.json stays absent */
      };

      handleClientMessage(
        { type: 'hooksConsentResponse', choice: 'install' },
        (m) => sent.push(m),
        ctx,
      );
      await settle();

      expect(store.getAdapter()!.getSetting('pixel-agents.hooksEnabled', true)).toBe(false);
      expect(sent.find((m) => m.type === 'hooksStatus')).toEqual({
        type: 'hooksStatus',
        installed: false,
      });
    });

    it('never persists hooks-off without touching settings.json or granting consent', async () => {
      let sideEffectRan = false;
      ctx.onSetHooksEnabled = () => {
        sideEffectRan = true;
      };

      handleClientMessage(
        { type: 'hooksConsentResponse', choice: 'never' },
        (m) => sent.push(m),
        ctx,
      );
      await settle();

      expect(store.getAdapter()!.getSetting('pixel-agents.hooksEnabled', true)).toBe(false);
      expect(sideEffectRan).toBe(false);
      expect(settingsJsonExists()).toBe(false);
      expect(consentGiven()).toBe(false);
    });

    it('notNow writes nothing at all', async () => {
      let sideEffectRan = false;
      ctx.onSetHooksEnabled = () => {
        sideEffectRan = true;
      };

      handleClientMessage(
        { type: 'hooksConsentResponse', choice: 'notNow' },
        (m) => sent.push(m),
        ctx,
      );
      await settle();

      expect(sideEffectRan).toBe(false);
      expect(settingsJsonExists()).toBe(false);
      expect(consentGiven()).toBe(false);
      expect(configJsonExists()).toBe(false);
    });

    // The retired TTY prompt's core pin, translated: junk must never be read
    // as approval — OR as a durable decline. Every unrecognized choice takes
    // the notNow path (write nothing, ask again), including near-misses of the
    // real values.
    it.each(['yes', 'y', '', 'Install', 'INSTALL', 'installl', 'not-now', 'NEVER', 42, true, null])(
      'unrecognized choice %j writes nothing',
      async (junk) => {
        let sideEffectRan = false;
        ctx.onSetHooksEnabled = () => {
          sideEffectRan = true;
        };

        handleClientMessage(
          { type: 'hooksConsentResponse', choice: junk },
          (m) => sent.push(m),
          ctx,
        );
        await settle();

        expect(sideEffectRan).toBe(false);
        expect(settingsJsonExists()).toBe(false);
        expect(consentGiven()).toBe(false);
        expect(configJsonExists()).toBe(false);
      },
    );

    // The answer is only ever solicited from privileged connections; one
    // arriving without the token is a crafted message, not a user decision.
    it('ignores every choice from an unprivileged client', async () => {
      ctx.privileged = false;
      let sideEffectRan = false;
      ctx.onSetHooksEnabled = () => {
        sideEffectRan = true;
      };

      for (const choice of ['install', 'never', 'notNow']) {
        handleClientMessage({ type: 'hooksConsentResponse', choice }, (m) => sent.push(m), ctx);
      }
      await settle();

      expect(sideEffectRan).toBe(false);
      expect(settingsJsonExists()).toBe(false);
      expect(consentGiven()).toBe(false);
      expect(configJsonExists()).toBe(false);
    });
  });

  // ── hooksConsentResponse revisions: Back from the Intro's closing step ───
  //
  // The Intro lets the user return to the consent step after an Install
  // already landed and pick a decline instead. A choice is an absolute
  // statement of desired state, so a decline over live hooks must UNDO the
  // install — recording a preference beside live entries is the stranding
  // bug (entries firing, checkbox lying, gate skipped forever).
  describe('hooksConsentResponse revision over a landed install', () => {
    /** What a successful uninstall leaves behind. */
    function removeOurHooks(): void {
      fs.writeFileSync(
        path.join(tempHome, '.claude', 'settings.json'),
        JSON.stringify({ hooks: {} }),
      );
    }

    it('a revised never takes the full toggle-off path: uninstall, then persist off', async () => {
      seedInstalledHooks();
      grantHooksConsent(); // the earlier Install recorded the grant
      let sideEffectEnabled: boolean | undefined;
      ctx.onSetHooksEnabled = (enabled) => {
        sideEffectEnabled = enabled;
        if (!enabled) removeOurHooks();
      };

      handleClientMessage(
        { type: 'hooksConsentResponse', choice: 'never' },
        (m) => sent.push(m),
        ctx,
      );
      await settle();

      expect(sideEffectEnabled).toBe(false);
      expect(store.getAdapter()!.getSetting('pixel-agents.hooksEnabled', true)).toBe(false);
      // The grant stays recorded, matching the Settings toggle: re-enabling
      // later installs without re-asking.
      expect(consentGiven()).toBe(true);
      expect(sent.find((m) => m.type === 'hooksStatus')).toEqual({
        type: 'hooksStatus',
        installed: false,
      });
    });

    it('a revised notNow reverts everything: uninstall, revoke the grant, preference untouched', async () => {
      seedInstalledHooks();
      grantHooksConsent();
      ctx.onSetHooksEnabled = (enabled) => {
        if (!enabled) removeOurHooks();
      };

      handleClientMessage(
        { type: 'hooksConsentResponse', choice: 'notNow' },
        (m) => sent.push(m),
        ctx,
      );
      await settle();

      expect(consentGiven()).toBe(false);
      // "Not now" must not persist hooks-off — that would retire the ask.
      expect(store.getAdapter()!.getSetting('pixel-agents.hooksEnabled', true)).toBe(true);
      expect(sent.find((m) => m.type === 'hooksStatus')).toEqual({
        type: 'hooksStatus',
        installed: false,
      });

      // The load-bearing half: the world is as if never answered, so the next
      // connect asks again.
      sent = [];
      await connect();
      expect(sent.find((m) => m.type === 'hooksConsentRequest')).toBeDefined();
    });

    // Fail closed on a failed undo: while entries are still on disk and still
    // firing, the grant must stay recorded — a revoked grant over live hooks
    // would make the startup migration re-grant silently, but the truthful
    // hooksStatus is what the UI renders either way.
    it('a failed revert keeps the grant and reports hooks still installed', async () => {
      seedInstalledHooks();
      grantHooksConsent();
      ctx.onSetHooksEnabled = () => {
        /* the uninstall failed: our entries stay */
      };

      handleClientMessage(
        { type: 'hooksConsentResponse', choice: 'notNow' },
        (m) => sent.push(m),
        ctx,
      );
      await settle();

      expect(consentGiven()).toBe(true);
      expect(sent.find((m) => m.type === 'hooksStatus')).toEqual({
        type: 'hooksStatus',
        installed: true,
      });
    });

    // The population issue #377 is about: a settings.json the installer
    // refuses to touch. `install` records the grant BEFORE it writes, so a
    // failed install leaves a grant with nothing on disk — and the grant alone
    // is what retires the ask. Reading the revert off `installed` saw "nothing
    // to undo" here and did nothing, stranding the user with an ask that never
    // came back.
    it('a revised notNow revokes a grant left by a FAILED install', async () => {
      grantHooksConsent(); // the Install click landed the grant...
      // ...and nothing is on disk: the install threw and wrote nothing.
      let uninstallAttempted = false;
      ctx.onSetHooksEnabled = () => {
        uninstallAttempted = true;
      };

      handleClientMessage(
        { type: 'hooksConsentResponse', choice: 'notNow' },
        (m) => sent.push(m),
        ctx,
      );
      await settle();

      expect(consentGiven()).toBe(false);
      // Nothing of ours is installed, so there is nothing to remove — and
      // routing through the uninstaller would surface a file error for the act
      // of declining.
      expect(uninstallAttempted).toBe(false);
      expect(store.getAdapter()!.getSetting('pixel-agents.hooksEnabled', true)).toBe(true);

      // The load-bearing half: the ask genuinely comes back.
      sent = [];
      await connect();
      expect(sent.find((m) => m.type === 'hooksConsentRequest')).toBeDefined();
    });

    // The Intro is DESIGNED to produce two answers in a row (walk Back from
    // the closing step, revise). Both are dispatched without awaiting, and
    // each re-reads the disk to decide what it means — so an unserialized
    // revision could observe the first answer's install mid-flight, read
    // "nothing installed", and degrade into its no-op variant, leaving hooks
    // installed against the user's final answer.
    it('serializes a revision sent while the first answer is still installing', async () => {
      let resolveInstall: (() => void) | undefined;
      ctx.onSetHooksEnabled = (enabled) => {
        if (enabled) {
          // The real side effect (cli.ts) grants BEFORE it writes, then
          // installs. Here the write is a slow one that only lands when we
          // let it, so the revision can arrive mid-flight.
          grantHooksConsent();
          return new Promise<void>((resolve) => {
            resolveInstall = () => {
              seedInstalledHooks();
              resolve();
            };
          });
        }
        removeOurHooks();
        return undefined;
      };

      handleClientMessage(
        { type: 'hooksConsentResponse', choice: 'install' },
        (m) => sent.push(m),
        ctx,
      );
      // The revision arrives before the install has written anything.
      handleClientMessage(
        { type: 'hooksConsentResponse', choice: 'never' },
        (m) => sent.push(m),
        ctx,
      );
      await settle();
      expect(resolveInstall).toBeDefined();
      resolveInstall!();
      await settle();

      // The revision ran AFTER the install landed, so it saw the hooks and
      // took the full toggle-off path rather than merely persisting a
      // preference beside live entries.
      expect(consentGiven()).toBe(true);
      expect(store.getAdapter()!.getSetting('pixel-agents.hooksEnabled', true)).toBe(false);
      expect(sent.filter((m) => m.type === 'hooksStatus').at(-1)).toEqual({
        type: 'hooksStatus',
        installed: false,
      });
    });
  });
});
