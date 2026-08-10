/**
 * Unit tests for the consent greeter — the char_0 character that "speaks" the
 * first-run hooks ask from near the office's bottom-left corner (ConsentBubble
 * is its speech bubble; these tests cover the OfficeState half).
 *
 * The greeter is deliberately NOT an agent: it must stand still (no wander
 * FSM), take no seat (not even across a layout rebuild), and stay invisible to
 * hit-testing so clicks pass through to the office. Spawn/despawn ride the
 * matrix effect, and despawn must be idempotent because every close path of
 * the bubble funnels into it.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import { CONSENT_GREETER_ID } from '../src/constants.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import type { OfficeLayout } from '../src/office/types.js';
import { CharacterState, MATRIX_EFFECT_DURATION, TileType } from '../src/office/types.js';

/** All-floor layout, no furniture — no catalog needed, every tile walkable. */
function floorLayout(cols = 9, rows = 7): OfficeLayout {
  return {
    version: 1,
    cols,
    rows,
    tiles: new Array<TileType>(cols * rows).fill(TileType.FLOOR_1),
    furniture: [],
  };
}

test('spawns 3 tiles in from the bottom-left, standing, without a seat', () => {
  const os = new OfficeState(floorLayout(9, 9));
  os.spawnConsentGreeter();

  const ch = os.getConsentGreeter();
  assert.ok(ch, 'greeter exists after spawn');
  assert.equal(ch.isGreeter, true);
  assert.equal(ch.tileCol, 3, '3 tiles in from the left edge');
  assert.equal(ch.tileRow, 5, '3 tiles up from the bottom edge of a 9-tall grid');
  assert.equal(ch.seatId, null, 'the greeter never takes a seat');
  assert.equal(ch.state, CharacterState.IDLE);
  assert.equal(ch.palette, 0, 'char_0 sprite');
  assert.equal(ch.hueShift, 0);
  assert.equal(ch.matrixEffect, 'spawn', 'materializes with the matrix effect');
});

test('falls back to the closest walkable tile when the target is not walkable', () => {
  // Void out the target tile (3, rows-4) = (3, 5): the greeter must stand on
  // the nearest walkable tile instead (Manhattan distance 1 on an open floor).
  const layout = floorLayout(9, 9);
  layout.tiles[5 * 9 + 3] = TileType.VOID;
  const os = new OfficeState(layout);
  os.spawnConsentGreeter();

  const ch = os.getConsentGreeter();
  assert.ok(ch, 'greeter exists after spawn');
  assert.notDeepEqual([ch.tileCol, ch.tileRow], [3, 5], 'not on the void tile');
  assert.equal(
    Math.abs(ch.tileCol - 3) + Math.abs(ch.tileRow - 5),
    1,
    'on a tile adjacent to the blocked target',
  );
});

test('stands still: minutes of updates never move it or start a walk', () => {
  const os = new OfficeState(floorLayout());
  os.spawnConsentGreeter();
  const ch = os.getConsentGreeter()!;
  const { x, y } = ch;

  // Let the spawn effect finish, then run far past every wander timer.
  for (let i = 0; i < 1200; i++) os.update(0.25); // 5 simulated minutes

  assert.equal(ch.matrixEffect, null, 'spawn effect completed');
  assert.equal(ch.x, x);
  assert.equal(ch.y, y);
  assert.equal(ch.state, CharacterState.IDLE, 'never entered WALK/TYPE');
  assert.equal(ch.path.length, 0);
});

test('spawn is idempotent, and revives a greeter caught mid-despawn', () => {
  const os = new OfficeState(floorLayout());
  os.spawnConsentGreeter();
  os.spawnConsentGreeter();
  assert.equal(
    Array.from(os.characters.values()).filter((c) => c.isGreeter).length,
    1,
    'double spawn keeps a single greeter',
  );

  // React StrictMode mounts effects twice: despawn (unmount) then respawn.
  // The respawn must cancel the pending removal or the greeter vanishes 0.3s in.
  os.despawnConsentGreeter();
  os.spawnConsentGreeter();
  const ch = os.getConsentGreeter()!;
  assert.equal(ch.matrixEffect, 'spawn', 'despawn flipped back to spawn');
  os.update(MATRIX_EFFECT_DURATION + 0.05);
  assert.ok(os.getConsentGreeter(), 'greeter survived the effect window');
});

test('despawn removes it after the matrix effect, idempotently', () => {
  const os = new OfficeState(floorLayout());
  os.spawnConsentGreeter();
  os.update(MATRIX_EFFECT_DURATION + 0.05); // finish spawn effect

  os.despawnConsentGreeter();
  os.despawnConsentGreeter(); // every bubble close path calls this — must not restart
  const ch = os.getConsentGreeter()!;
  assert.equal(ch.matrixEffect, 'despawn');

  os.update(MATRIX_EFFECT_DURATION + 0.05);
  assert.equal(os.getConsentGreeter(), null, 'removed once the effect finished');
});

test('is invisible to hit-testing — clicks pass through', () => {
  const os = new OfficeState(floorLayout());
  os.spawnConsentGreeter();
  os.update(MATRIX_EFFECT_DURATION + 0.05);
  const ch = os.getConsentGreeter()!;

  assert.equal(os.getCharacterAt(ch.x, ch.y - 1), null, 'no hit on the greeter sprite');
});

test('a layout rebuild never seats or repositions the greeter', () => {
  const os = new OfficeState(floorLayout());
  os.spawnConsentGreeter();
  os.update(MATRIX_EFFECT_DURATION + 0.05);
  const ch = os.getConsentGreeter()!;
  const { tileCol, tileRow } = ch;

  os.rebuildFromLayout(floorLayout());

  assert.equal(ch.seatId, null, 'still unseated after rebuild');
  assert.equal(ch.tileCol, tileCol);
  assert.equal(ch.tileRow, tileRow);
});

test('consent camera target: per-frame updates land until a manual pan cancels them', () => {
  const os = new OfficeState(floorLayout());
  os.spawnConsentGreeter();

  os.setConsentCameraTarget({ x: 10, y: 20 });
  assert.deepEqual(os.consentCameraTarget, { x: 10, y: 20 });

  // Manual pan: target cleared AND later per-frame updates ignored.
  os.cancelConsentCamera();
  assert.equal(os.consentCameraTarget, null);
  os.setConsentCameraTarget({ x: 30, y: 40 });
  assert.equal(os.consentCameraTarget, null, 'updates stay ignored after cancel');

  // A fresh ask (respawn) re-arms the centering.
  os.despawnConsentGreeter();
  os.spawnConsentGreeter();
  os.setConsentCameraTarget({ x: 5, y: 6 });
  assert.deepEqual(os.consentCameraTarget, { x: 5, y: 6 });
});

test('CONSENT_GREETER_ID cannot collide with sub-agent ids', () => {
  const os = new OfficeState(floorLayout());
  os.spawnConsentGreeter();
  const subId = os.addSubagent(1, 'tool-1');
  assert.ok(subId > CONSENT_GREETER_ID, 'sub-agent ids count down from -1, far above the greeter');
  assert.equal(os.getConsentGreeter()!.isGreeter, true);
});
