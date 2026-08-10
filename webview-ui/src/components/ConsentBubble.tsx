import { useEffect, useRef, useState } from 'react';

import {
  CHARACTER_HIT_HALF_WIDTH,
  CONSENT_BUBBLE_ANCHOR_RISE_WORLD,
  CONSENT_BUBBLE_EDGE_MARGIN_PX,
  CONSENT_BUBBLE_MAX_WIDTH_PX,
  CONSENT_BUBBLE_OFFSET_X_WORLD,
  CONSENT_CAMERA_DOWN_SHIFT_PX,
  CONSENT_CAMERA_MAX_X_OFFSET_VIEWPORT_FRACTION,
  CONSENT_CAMERA_MIN_CHAR_VISIBLE_WORLD,
  CONSENT_TAIL_STEPS,
  CONSENT_TAIL_TARGET_RISE_WORLD,
} from '../constants.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { TILE_SIZE } from '../office/types.js';
import { Button } from './ui/Button.js';

export type ConsentChoice = 'install' | 'notNow' | 'never';

interface ConsentBubbleProps {
  officeState: OfficeState;
  /** Server-provided copy (hooksConsentRequest). Rendered verbatim so the
   *  bubble shows the exact terms being approved — the webview keeps no copy
   *  of its own to drift out of sync with the server's disclosure. */
  headline: string;
  disclosure: string;
  containerRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  panRef: React.RefObject<{ x: number; y: number }>;
  /** An explicit button click: sends the choice to the server. */
  onChoice: (choice: ConsentChoice) => void;
  /** Escape: closes the ask and sends NOTHING — the server asks again the
   *  next time the office is opened. */
  onDismiss: () => void;
}

/**
 * First-run hooks consent ask, shared by both surfaces (the VS Code webview
 * and the standalone browser render this same component off the same server
 * message).
 *
 * Diegetic: a greeter character (char_0) stands at the center of the office
 * and this component is its speech bubble, anchored up-right of its head like
 * ToolOverlay anchors above agents. Mounting spawns the greeter; EVERY close
 * path — a button, Escape, or a hooksStatus that moots the ask — unmounts this
 * component, and the unmount despawns the greeter, so the two can never
 * disagree. While mounted it feeds officeState.consentCameraTarget so the
 * camera drifts to center character + bubble together (a manual pan cancels
 * that; see OfficeState.cancelConsentCamera).
 *
 * Fail-closed by construction: only the three buttons send anything, and only
 * `install` / `never` make the server write. Escape dismisses without sending,
 * so an unanswered ask changes nothing and reappears on the next open. Clicks
 * on the office around the bubble are deliberately inert — this is a decision
 * surface, and a stray click must not read as an answer.
 */
export function ConsentBubble({
  officeState,
  headline,
  disclosure,
  containerRef,
  zoom,
  panRef,
  onChoice,
  onDismiss,
}: ConsentBubbleProps) {
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [, setTick] = useState(0);

  // The greeter lives exactly as long as this component.
  useEffect(() => {
    officeState.spawnConsentGreeter();
    return () => officeState.despawnConsentGreeter();
  }, [officeState]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onDismiss();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onDismiss]);

  // Track the greeter every frame (same pattern as ToolOverlay) and feed the
  // camera the combined character+bubble center in world coords. The offsets
  // are CAPPED against the viewport: the ideal composition assumes the bubble
  // fits up-right of the character, and when a small viewport clamps the bubble
  // to the screen instead, the uncapped center would shove the greeter to the
  // viewport edge.
  useEffect(() => {
    let rafId = 0;
    const tick = () => {
      const ch = officeState.getConsentGreeter();
      const bubble = bubbleRef.current;
      const container = containerRef.current;
      if (ch && bubble && container && bubble.offsetWidth > 0) {
        const dpr = window.devicePixelRatio || 1;
        const crect = container.getBoundingClientRect();
        const viewportW = (crect.width * dpr) / zoom;
        const viewportH = (crect.height * dpr) / zoom;
        const bw = (bubble.offsetWidth * dpr) / zoom;
        const bh = (bubble.offsetHeight * dpr) / zoom;
        const offX = Math.min(
          (CONSENT_BUBBLE_OFFSET_X_WORLD + bw - CHARACTER_HIT_HALF_WIDTH) / 2,
          viewportW * CONSENT_CAMERA_MAX_X_OFFSET_VIEWPORT_FRACTION,
        );
        const offY = Math.min(
          (CONSENT_BUBBLE_ANCHOR_RISE_WORLD + bh) / 2,
          viewportH / 2 - CONSENT_CAMERA_MIN_CHAR_VISIBLE_WORLD,
        );
        // Aim BELOW the composition center: the camera moves down, so the
        // character + bubble land a bit above the vertical center of the view.
        const downShift = (CONSENT_CAMERA_DOWN_SHIFT_PX * dpr) / zoom;
        officeState.setConsentCameraTarget({
          x: ch.x + offX,
          y: ch.y - Math.max(0, offY) + downShift,
        });
      }
      setTick((n) => n + 1);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [officeState, zoom, containerRef]);

  const el = containerRef.current;
  if (!el) return null;

  const greeter = officeState.getConsentGreeter();
  // Let the materialization effect finish before the greeter "speaks".
  if (greeter && greeter.matrixEffect === 'spawn') return null;

  const rect = el.getBoundingClientRect();
  const margin = CONSENT_BUBBLE_EDGE_MARGIN_PX;
  const maxWidth = Math.min(CONSENT_BUBBLE_MAX_WIDTH_PX, rect.width - 2 * margin);

  // Anchor the bubble's bottom-left up-right of the greeter's head, clamped
  // into the container. Measurements come from the previous frame's node (the
  // rAF tick re-renders continuously); until the first measure, stay hidden.
  const bw = bubbleRef.current?.offsetWidth ?? 0;
  const bh = bubbleRef.current?.offsetHeight ?? 0;
  const measured = bw > 0 && bh > 0;

  let wrapperStyle: React.CSSProperties;
  // Tail squares connecting the bubble to the greeter's head, in WRAPPER
  // coordinates. Recomputed from the live geometry every frame, so the tail
  // keeps pointing at the head even when edge-clamping or a manual pan moves
  // the bubble away from its preferred spot above the character.
  let tailSquares: Array<{ x: number; y: number; size: number }> = [];
  if (greeter) {
    const dpr = window.devicePixelRatio || 1;
    const canvasW = Math.round(rect.width * dpr);
    const canvasH = Math.round(rect.height * dpr);
    const layout = officeState.getLayout();
    const mapW = layout.cols * TILE_SIZE * zoom;
    const mapH = layout.rows * TILE_SIZE * zoom;
    const deviceOffsetX = Math.floor((canvasW - mapW) / 2) + Math.round(panRef.current.x);
    const deviceOffsetY = Math.floor((canvasH - mapH) / 2) + Math.round(panRef.current.y);
    const anchorX = (deviceOffsetX + (greeter.x + CONSENT_BUBBLE_OFFSET_X_WORLD) * zoom) / dpr;
    const anchorY = (deviceOffsetY + (greeter.y - CONSENT_BUBBLE_ANCHOR_RISE_WORLD) * zoom) / dpr;
    const left = Math.max(margin, Math.min(anchorX, rect.width - bw - margin));
    const top = Math.max(margin, Math.min(anchorY - bh, rect.height - bh - margin));
    wrapperStyle = { left, top };

    if (measured) {
      // Head point (container CSS px) and its closest point on the bubble's
      // rectangle — squares step along that segment, shrinking toward the head.
      const headX = (deviceOffsetX + greeter.x * zoom) / dpr;
      const headY = (deviceOffsetY + (greeter.y - CONSENT_TAIL_TARGET_RISE_WORLD) * zoom) / dpr;
      const edgeX = Math.max(left, Math.min(headX, left + bw));
      const edgeY = Math.max(top, Math.min(headY, top + bh));
      tailSquares = CONSENT_TAIL_STEPS.map(({ t, size }) => ({
        x: edgeX + (headX - edgeX) * t - left - size / 2,
        y: edgeY + (headY - edgeY) * t - top - size / 2,
        size,
      }));
    }
  } else {
    // Degenerate layout (no walkable tile for the greeter): the ask still must
    // be answerable, so fall back to a centered panel without the character.
    wrapperStyle = { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' };
  }

  return (
    <div
      className="absolute z-45"
      style={{ ...wrapperStyle, visibility: measured || !greeter ? undefined : 'hidden' }}
    >
      {/* Tail squares render BEFORE the panel so the bubble paints over any
          overlap when the head sits right under (or behind) the panel. */}
      {tailSquares.map(({ x, y, size }, i) => (
        <div
          key={i}
          aria-hidden
          className="absolute"
          style={{
            left: x,
            top: y,
            width: size,
            height: size,
            background: 'var(--color-bg)',
            border: '2px solid var(--color-border)',
          }}
        />
      ))}
      <div
        ref={bubbleRef}
        role="dialog"
        aria-label={headline}
        className="pixel-panel relative py-10 px-14 leading-[1.4]"
        style={{ maxWidth }}
      >
        <div className="text-xl mb-8 text-accent-bright">{headline}</div>
        {disclosure.split('\n\n').map((paragraph, i) => (
          <p key={i} className="text-sm m-0 mb-8">
            {paragraph}
          </p>
        ))}
        <div className="flex items-center justify-end gap-6 mt-10 flex-wrap">
          <Button variant="ghost" size="sm" onClick={() => onChoice('never')}>
            Don't Ask Again
          </Button>
          <Button variant="default" size="sm" onClick={() => onChoice('notNow')}>
            Not Now
          </Button>
          <Button variant="accent" size="sm" onClick={() => onChoice('install')}>
            Install Hooks
          </Button>
        </div>
      </div>
    </div>
  );
}
