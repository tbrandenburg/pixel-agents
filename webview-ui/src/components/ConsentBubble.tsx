import { useEffect, useRef, useState } from 'react';

import { CONSENT_BUBBLE_EDGE_MARGIN_PX, CONSENT_BUBBLE_MAX_WIDTH_PX } from '../constants.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { computeConsentBubbleGeometry } from './consentBubbleGeometry.js';
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
 * Diegetic: a greeter character (char_0) stands near the office's bottom-left
 * corner and this component is its speech bubble, anchored up-right of its
 * head like ToolOverlay anchors above agents. Mounting spawns the greeter;
 * EVERY close path — a button, Escape, or a hooksStatus that moots the ask —
 * unmounts this component, and the unmount despawns the greeter, so the two
 * can never disagree. While mounted it feeds officeState.consentCameraTarget
 * so the camera drifts to center character + bubble together (a manual pan
 * cancels that; see OfficeState.cancelConsentCamera).
 *
 * All geometry — bubble position, tail, camera target — comes from
 * computeConsentBubbleGeometry, a pure per-frame function of the measured
 * frame; this component only measures and renders.
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

  // Per-frame tick (same pattern as ToolOverlay): re-render — the greeter's
  // matrix effect, a pan, and the camera drift all move the anchor between
  // renders — and feed the camera target from the same geometry the render
  // uses, so the drift and the drawn bubble can never disagree. Ignored after
  // a manual pan (cancelConsentCamera).
  useEffect(() => {
    let rafId = 0;
    const tick = () => {
      const ch = officeState.getConsentGreeter();
      const bubble = bubbleRef.current;
      const container = containerRef.current;
      if (ch && bubble && container && bubble.offsetWidth > 0) {
        officeState.setConsentCameraTarget(
          computeConsentBubbleGeometry({
            layout: officeState.getLayout(),
            containerRect: container.getBoundingClientRect(),
            zoom,
            pan: panRef.current,
            dpr: window.devicePixelRatio || 1,
            greeter: ch,
            bubbleWidth: bubble.offsetWidth,
            bubbleHeight: bubble.offsetHeight,
          }).cameraTarget,
        );
      }
      setTick((n) => n + 1);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [officeState, zoom, containerRef, panRef]);

  const el = containerRef.current;
  if (!el) return null;

  const greeter = officeState.getConsentGreeter();
  // Let the materialization effect finish before the greeter "speaks".
  if (greeter && greeter.matrixEffect === 'spawn') return null;

  const rect = el.getBoundingClientRect();
  const maxWidth = Math.min(
    CONSENT_BUBBLE_MAX_WIDTH_PX,
    rect.width - 2 * CONSENT_BUBBLE_EDGE_MARGIN_PX,
  );

  // Measurements come from the previous frame's node (the rAF tick re-renders
  // continuously); until the first measure, stay hidden.
  const bw = bubbleRef.current?.offsetWidth ?? 0;
  const bh = bubbleRef.current?.offsetHeight ?? 0;
  const measured = bw > 0 && bh > 0;

  let wrapperStyle: React.CSSProperties;
  let tailSquares: Array<{ x: number; y: number; size: number }> = [];
  if (greeter) {
    const geometry = computeConsentBubbleGeometry({
      layout: officeState.getLayout(),
      containerRect: rect,
      zoom,
      pan: panRef.current,
      dpr: window.devicePixelRatio || 1,
      greeter,
      bubbleWidth: bw,
      bubbleHeight: bh,
    });
    wrapperStyle = { left: geometry.left, top: geometry.top };
    tailSquares = geometry.tailSquares;
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
