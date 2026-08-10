import fs from 'node:fs';
import path from 'node:path';

import type { Frame, Locator } from '@playwright/test';

import { expect, test } from '../../../fixtures/pixel-agents';
import { getSettingChecked, setSettings } from '../../../helpers/webview';

/**
 * First-run consent for modifying ~/.claude/settings.json.
 *
 * Every other spec seeds `hooksConsentGiven: true` (e2e/helpers/launch.ts) so
 * hooks flow without a prompt. These specs opt OUT via `seedConfig`: a config
 * without the key parses to false (server/src/configPersistence.ts), which is
 * exactly what a real first run looks like.
 *
 * The ask is rendered IN THE APP, diegetically: a greeter character stands at
 * the center of the office and the webview's ConsentBubble — its speech
 * bubble, driven by the server's `hooksConsentRequest` during the webviewReady
 * handshake — carries the disclosure and the three buttons. These specs
 * address it inside the Pixel Agents frame, not in VS Code chrome. Both
 * surfaces (VS Code webview and standalone browser) render this same component
 * off the same message; the standalone side is pinned in
 * e2e/tests/standalone/hooks.spec.ts.
 *
 * The gate is the answer to a 1-star Marketplace review: Pixel Agents replaced
 * a user's whole settings.json with no prompt, no backup, and no disclosure.
 * These tests assert the on-disk consequences of each choice, not just that a
 * prompt appeared.
 */

const NO_CONSENT_CONFIG = {
  vscode: { alwaysShowLabels: true },
  standalone: { alwaysShowLabels: true },
  // hooksConsentGiven deliberately absent -> parses to false -> dialog shows.
};

/** The in-app consent ask. ConsentBubble is the only role="dialog" element
 *  in the webview (the Settings/changelog modals don't carry the role). */
function consentDialog(frame: Frame): Locator {
  return frame.getByRole('dialog');
}

type GreeterHooks = {
  getCharacters?: () => Array<{ isGreeter?: boolean }>;
};

/** Whether the consent greeter character is currently in the office. */
function greeterPresent(frame: Frame): Promise<boolean> {
  return frame.evaluate(() => {
    const hooks = (window as { __pixelAgentsTestHooks?: GreeterHooks }).__pixelAgentsTestHooks;
    return (hooks?.getCharacters?.() ?? []).some((c) => c.isGreeter === true);
  });
}

/** Wait for the first-run consent dialog and return it. */
async function openConsentDialog(frame: Frame): Promise<Locator> {
  const dialog = consentDialog(frame);
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  return dialog;
}

function settingsPath(tmpHome: string): string {
  return path.join(tmpHome, '.claude', 'settings.json');
}

function readSettings(tmpHome: string): {
  hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
  permissions?: unknown;
} {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(tmpHome), 'utf8'));
  } catch {
    return {};
  }
}

/** Events carrying one of our hook commands. */
function ourHookEvents(tmpHome: string): string[] {
  const hooks = readSettings(tmpHome).hooks ?? {};
  return Object.entries(hooks)
    .filter(([, entries]) =>
      (entries ?? []).some((entry) =>
        (entry.hooks ?? []).some((h) => h.command?.includes('.pixel-agents/hooks/claude-hook.js')),
      ),
    )
    .map(([event]) => event)
    .sort();
}

function readConsent(tmpHome: string): boolean {
  try {
    const raw = fs.readFileSync(path.join(tmpHome, '.pixel-agents', 'config.json'), 'utf8');
    return (JSON.parse(raw) as { hooksConsentGiven?: boolean }).hooksConsentGiven === true;
  } catch {
    return false;
  }
}

function readHooksEnabled(tmpHome: string): boolean | undefined {
  try {
    const raw = fs.readFileSync(path.join(tmpHome, '.pixel-agents', 'config.json'), 'utf8');
    return (JSON.parse(raw) as { vscode?: { hooksEnabled?: boolean } }).vscode?.hooksEnabled;
  } catch {
    return undefined;
  }
}

/**
 * A pre-consent (legacy) settings.json: our command on 14 events, including the
 * two we no longer collect, plus a third-party hook sharing one entry.
 *
 * The hook command is matched by its `.pixel-agents/hooks/claude-hook.js` path
 * SUFFIX, not against the resolved homedir, so a literal `/home/legacy/...`
 * path is recognized as ours even though the test HOME is a temp dir. That is
 * what lets this be seeded at launch time, before the temp HOME's name exists.
 */
function legacyClaudeSettings(thirdPartyCommand: string): unknown {
  const command = 'node "/home/legacy/.pixel-agents/hooks/claude-hook.js"';
  const events = [
    'SessionStart',
    'SessionEnd',
    'Stop',
    'PermissionRequest',
    'Notification',
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'PostToolUseFailure',
    'SubagentStart',
    'SubagentStop',
    'TeammateIdle',
    'TaskCreated',
    'TaskCompleted',
  ];
  const hooks: Record<string, unknown[]> = {};
  for (const event of events) {
    hooks[event] = [{ matcher: '', hooks: [{ type: 'command', command, timeout: 5 }] }];
  }
  (hooks['UserPromptSubmit'] as Array<{ hooks: Array<unknown> }>)[0].hooks.unshift({
    type: 'command',
    command: thirdPartyCommand,
  });
  return { permissions: { allow: ['Bash(ls:*)'] }, hooks };
}

test.describe('Hooks consent gate', () => {
  test.use({ seedConfig: NO_CONSENT_CONFIG });

  test('fresh install: the dialog discloses scope and Install writes the hooks @area:cross-cutting', async ({
    pixelAgents,
  }) => {
    const { frame, tmpHome, narrator } = pixelAgents;

    narrator.step('waiting for the first-run consent dialog');
    const dialog = await openConsentDialog(frame);

    // The disclosure is the point: what is written, what data moves, how to undo.
    const text = (await dialog.textContent()) ?? '';
    expect(text).toContain('Welcome to Pixel Agents!');
    expect(text).toMatch(/adds hooks for 12 Claude Code events/);
    expect(text).toContain('~/.claude/settings.json');
    expect(text).toContain('.pixel-agents.backup');
    expect(text).toMatch(/tool inputs/);
    expect(text).toContain('127.0.0.1');
    // The LAST sentence of the disclosure — asserted at the tail so a clipped
    // or half-rendered body fails here rather than passing on its opening.
    expect(text).toContain('Instant Detection (Hooks)');
    narrator.check('bubble discloses event scope, payload destination, and how to remove');

    // Diegetic: the ask is a greeter character's speech bubble, and the camera
    // shifts so character + bubble are centered — the bubble ends up FULLY on
    // screen (polled, because the camera lerps there over a few frames). That
    // is what makes it unmissable without an office-blocking overlay.
    expect(await greeterPresent(frame)).toBe(true);
    await expect
      .poll(
        () =>
          frame.evaluate(() => {
            const el = document.querySelector('[role="dialog"]');
            if (!el) return false;
            const r = el.getBoundingClientRect();
            return (
              r.width > 0 &&
              r.left >= 0 &&
              r.top >= 0 &&
              r.right <= window.innerWidth &&
              r.bottom <= window.innerHeight
            );
          }),
        { timeout: 10_000 },
      )
      .toBe(true);
    narrator.check('a greeter character speaks the ask; the camera centers it fully on screen');

    // THREE buttons, and exactly these three. The native predecessor of this
    // dialog once shipped a synthesized fourth Cancel that did precisely what
    // "Not Now" did — two controls, one behavior, on the surface a Marketplace
    // reviewer reads most closely. Asserted as an exact SET, not a count: a
    // bare count of 3 still passes if a later edit swaps one button for
    // another dismissal synonym.
    expect(
      (await dialog.getByRole('button').allTextContents()).map((t) => t.trim()).sort(),
    ).toEqual(["Don't Ask Again", 'Install Hooks', 'Not Now'].sort());
    narrator.check('exactly three buttons — no duplicate Cancel beside Not Now');

    // Nothing has been written yet — the dialog precedes any modification.
    expect(fs.existsSync(settingsPath(tmpHome))).toBe(false);

    narrator.step('clicking Install Hooks');
    await dialog.getByRole('button', { name: 'Install Hooks' }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    // Answering the ask despawns the greeter (matrix effect, then removal).
    await expect.poll(() => greeterPresent(frame), { timeout: 15_000 }).toBe(false);
    narrator.check('the greeter despawned once the ask was answered');

    await expect.poll(() => ourHookEvents(tmpHome).length, { timeout: 15_000 }).toBe(12);
    expect(ourHookEvents(tmpHome)).not.toContain('UserPromptSubmit');
    expect(ourHookEvents(tmpHome)).not.toContain('TaskCreated');
    expect(readConsent(tmpHome)).toBe(true);
    narrator.check('12 events installed, prompt-forwarding events not among them');

    // The checkbox reflects ACTUAL install state, fed by the hooksStatus message.
    await expect
      .poll(() => getSettingChecked(frame, 'Instant Detection (Hooks)'), { timeout: 15_000 })
      .toBe(true);
    narrator.check('Settings shows Instant Detection ON');
  });

  test('Not Now writes nothing and leaves consent ungranted @area:cross-cutting', async ({
    pixelAgents,
  }) => {
    const { frame, tmpHome, narrator } = pixelAgents;

    const dialog = await openConsentDialog(frame);

    narrator.step('declining with Not Now');
    await dialog.getByRole('button', { name: 'Not Now' }).click();
    // Answering closes the dialog and releases the office.
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    // Settle: an install, had it happened, would land well inside this window.
    await frame.page().waitForTimeout(3_000);
    expect(fs.existsSync(settingsPath(tmpHome))).toBe(false);
    expect(readConsent(tmpHome)).toBe(false);
    // Not Now persists nothing — the user is asked again next time they open
    // the office.
    expect(readHooksEnabled(tmpHome)).not.toBe(false);
    narrator.check('settings.json never created, consent still ungranted');

    expect(await getSettingChecked(frame, 'Instant Detection (Hooks)')).toBe(false);
    narrator.check('Settings shows Instant Detection OFF — the checkbox tells the truth');
  });

  test("Don't Ask Again writes nothing and persists hooks off @area:cross-cutting", async ({
    pixelAgents,
  }) => {
    const { frame, tmpHome, narrator } = pixelAgents;

    const dialog = await openConsentDialog(frame);

    narrator.step("declining permanently with Don't Ask Again");
    await dialog.getByRole('button', { name: "Don't Ask Again" }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    await expect.poll(() => readHooksEnabled(tmpHome), { timeout: 15_000 }).toBe(false);
    expect(fs.existsSync(settingsPath(tmpHome))).toBe(false);
    expect(readConsent(tmpHome)).toBe(false);
    narrator.check('hooksEnabled persisted false, settings.json untouched');
  });

  // Dismissing WITHOUT choosing. Escape is the one dismissal route the dialog
  // offers (there is deliberately no close 'x' and no backdrop-click dismissal
  // — see the next test), and a dismissal must behave like Not Now and NOT
  // like "Don't Ask Again": the difference is whether the user is ever asked
  // again, and a dismissal that silently persisted hooks-off would strand them
  // with the gate skipped forever. Fail-closed, the dismissal SENDS nothing —
  // there is no message whose mishandling could turn it into an approval.
  test('dismissing the dialog writes nothing, exactly like Not Now @area:cross-cutting', async ({
    pixelAgents,
  }) => {
    const { frame, tmpHome, narrator } = pixelAgents;

    const dialog = await openConsentDialog(frame);
    // No dismissal synonyms: neither a Cancel button nor a close 'x'.
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'x', exact: true })).toHaveCount(0);

    narrator.step('dismissing the dialog with Escape — no button chosen');
    // Click a non-interactive spot first so keyboard focus is inside the
    // webview iframe (the fixture's layout pass leaves it on workbench chrome).
    await dialog.click({ position: { x: 8, y: 8 } });
    await frame.page().keyboard.press('Escape');
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    // Settle: an install, had it happened, would land well inside this window.
    await frame.page().waitForTimeout(3_000);
    expect(fs.existsSync(settingsPath(tmpHome))).toBe(false);
    expect(readConsent(tmpHome)).toBe(false);
    // The load-bearing half: dismissal must NOT persist hooks-off, or the next
    // open skips the gate and the user is never asked again.
    expect(readHooksEnabled(tmpHome)).not.toBe(false);
    narrator.check('settings.json never created, consent ungranted, hooks-off not persisted');
  });

  // A stray click on the office around the bubble must not read as an answer —
  // OR as a dismissal. This is a decision surface: only the three buttons and
  // Escape do anything at all. The office is live behind the ask (that is the
  // point of the diegetic bubble), so the most common accidental gesture —
  // clicking somewhere in the office — must leave the ask exactly where it was.
  test('clicking the office around the bubble neither answers nor dismisses @area:cross-cutting', async ({
    pixelAgents,
  }) => {
    const { frame, tmpHome, narrator } = pixelAgents;

    const dialog = await openConsentDialog(frame);

    narrator.step('clicking the office beside the greeter');
    // Top-left corner of the canvas — away from the centered character+bubble.
    // force: the click targets the canvas even if some overlay pixel intercepts.
    await frame.locator('canvas').click({ position: { x: 8, y: 8 }, force: true });
    await frame.page().waitForTimeout(1_000);

    await expect(dialog).toBeVisible();
    expect(fs.existsSync(settingsPath(tmpHome))).toBe(false);
    expect(readConsent(tmpHome)).toBe(false);
    expect(readHooksEnabled(tmpHome)).not.toBe(false);
    narrator.check('bubble still open, nothing written — a stray click is not an answer');
  });
});

const THIRD_PARTY = 'node /elsewhere/other-tool.js';

test.describe('Hooks consent gate / pre-consent install', () => {
  // The legacy install must exist BEFORE the extension activates — the gate
  // reads settings.json during activation, so a test-body write is too late.
  test.use({
    seedConfig: NO_CONSENT_CONFIG,
    seedClaudeSettings: legacyClaudeSettings(THIRD_PARTY),
  });

  // ZERO friction for the population that already had our hooks: no prompt at
  // all, just the migration. The reinstall only ever REDUCES scope — it drops
  // UserPromptSubmit and TaskCreated, the two events that forwarded prompt text
  // and were consumed by nothing — so a prompt would buy this user nothing they
  // do not already have. The removal route the disclosure promises is the
  // Settings toggle, exercised end-to-end by the next test.
  test('a pre-consent 14-event install migrates to 12 with no prompt @area:cross-cutting', async ({
    pixelAgents,
  }) => {
    const { frame, tmpHome, narrator } = pixelAgents;

    await expect.poll(() => ourHookEvents(tmpHome).length, { timeout: 30_000 }).toBe(12);
    expect(ourHookEvents(tmpHome)).not.toContain('UserPromptSubmit');
    expect(ourHookEvents(tmpHome)).not.toContain('TaskCreated');
    expect(readConsent(tmpHome)).toBe(true);
    // The third-party hook that shared the UserPromptSubmit entry survives.
    expect(JSON.stringify(readSettings(tmpHome))).toContain(THIRD_PARTY);
    // And the unrelated settings key nobody asked us to touch.
    expect(readSettings(tmpHome).permissions).toEqual({ allow: ['Bash(ls:*)'] });
    narrator.check('migrated to 12 events; third-party hook and unrelated keys survived');

    // The whole point: nothing was ever asked. The consent dialog stays open
    // until answered, so it would still be on screen right now — an absent
    // dialog here means none was ever raised. Two ways this fails if a prompt
    // comes back: the dialog assertion below, and the migration poll above,
    // which could not have reached 12 with the install gated behind an
    // unanswered dialog. Matched on the dialog role and again on the tail of
    // the shared disclosure block, which EVERY consent variant carries, so a
    // re-introduced prompt of any wording fails this.
    narrator.step('checking for a consent dialog');
    await expect(consentDialog(frame)).toHaveCount(0);
    await expect(frame.getByText(/remove the hooks at any time/i)).toHaveCount(0);
    narrator.check('no consent dialog was ever raised');

    // Migrated hooks are live, and the checkbox says so.
    await expect
      .poll(() => getSettingChecked(frame, 'Instant Detection (Hooks)'), { timeout: 15_000 })
      .toBe(true);
    narrator.check('Settings shows Instant Detection ON');
  });

  // The undo route the disclosure PROMISES ("You can remove the hooks at any
  // time from Settings → Instant Detection (Hooks)"), driven for exactly the
  // population that gets no prompt. With the Remove Hooks button gone this is
  // their ONLY removal route, so it is asserted end-to-end — toggle off,
  // entries gone from disk — rather than assumed from the toggle existing.
  test('Settings toggle removes the migrated hooks and keeps third-party entries @area:cross-cutting', async ({
    pixelAgents,
  }) => {
    const { frame, tmpHome, narrator } = pixelAgents;

    // The silent migration lands first, so the toggle below is a genuine state
    // change over live hooks rather than a no-op click.
    await expect.poll(() => ourHookEvents(tmpHome).length, { timeout: 30_000 }).toBe(12);
    expect(await getSettingChecked(frame, 'Instant Detection (Hooks)')).toBe(true);
    narrator.check('migrated hooks installed and the checkbox reads ON');

    narrator.step('toggling Instant Detection (Hooks) OFF');
    await setSettings(frame, { hooksEnabled: false });

    await expect.poll(() => ourHookEvents(tmpHome).length, { timeout: 15_000 }).toBe(0);
    expect(JSON.stringify(readSettings(tmpHome))).toContain(THIRD_PARTY);
    await expect.poll(() => readHooksEnabled(tmpHome), { timeout: 15_000 }).toBe(false);
    // Removal turns hooks OFF; it does not revoke the consent the migration
    // recorded, so re-enabling later installs without re-asking.
    expect(readConsent(tmpHome)).toBe(true);
    narrator.check('our entries gone, third-party hook kept, hooks persisted off');

    expect(await getSettingChecked(frame, 'Instant Detection (Hooks)')).toBe(false);
    narrator.check('Settings shows Instant Detection OFF');
  });
});

/**
 * The ordinary Settings toggle, when the uninstall CANNOT succeed.
 *
 * The preference used to be persisted before the removal was attempted, so a
 * failed uninstall stranded the user: the entries stayed on disk and kept
 * firing, while the persisted hooks-off made the next activation skip the
 * consent/install path entirely — never asked again, and the checkbox read
 * "off" so clicking it would install rather than remove.
 *
 * Consent is seeded, so this is the ordinary toggle path and not the gate. The
 * failure is forced by making ~/.claude unwritable AFTER a real install, which
 * is the state that matters: hooks genuinely installed and firing, checkbox
 * genuinely ON, and a removal that cannot land.
 */
test.describe('Hooks consent gate / toggle-off failure', () => {
  test.use({ seedConfig: { vscode: { alwaysShowLabels: true }, hooksConsentGiven: true } });

  test.skip(process.platform === 'win32', 'chmod-based write failure is not meaningful on Windows');

  test('a failed uninstall does not persist hooks-off @area:cross-cutting', async ({
    pixelAgents,
  }) => {
    const { frame, tmpHome, narrator } = pixelAgents;
    const claudeDir = path.join(tmpHome, '.claude');

    // Startup installed for real (consent seeded), so the checkbox is ON and
    // the toggle below is a genuine state change rather than a no-op click.
    await expect.poll(() => ourHookEvents(tmpHome).length, { timeout: 30_000 }).toBe(12);
    expect(await getSettingChecked(frame, 'Instant Detection (Hooks)')).toBe(true);
    narrator.check('hooks installed and the checkbox reads ON');

    const before = fs.readFileSync(settingsPath(tmpHome), 'utf8');
    try {
      fs.chmodSync(claudeDir, 0o500); // read+execute only: no write can land
      narrator.step('toggling hooks OFF while ~/.claude cannot be written');
      await setSettings(frame, { hooksEnabled: false });

      // Settle: the persist, had it happened, lands well inside this window.
      await frame.page().waitForTimeout(3_000);

      // The entries are still there and still firing...
      expect(fs.readFileSync(settingsPath(tmpHome), 'utf8')).toBe(before);
      // ...so the preference must NOT say hooks-off, or the next activation
      // skips the install path and the user is never asked again.
      expect(readHooksEnabled(tmpHome)).not.toBe(false);
      narrator.check('hooks still installed and hooksEnabled not persisted off');
    } finally {
      fs.chmodSync(claudeDir, 0o700); // or teardown cannot remove tmpHome
    }
  });
});
