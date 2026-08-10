import { useEffect } from 'react';

import { Button } from './ui/Button.js';

export type ConsentChoice = 'install' | 'notNow' | 'never';

interface ConsentModalProps {
  /** Server-provided copy (hooksConsentRequest). Rendered verbatim so the
   *  dialog shows the exact terms being approved — the webview keeps no copy
   *  of its own to drift out of sync with the server's disclosure. */
  headline: string;
  disclosure: string;
  /** An explicit button click: sends the choice to the server. */
  onChoice: (choice: ConsentChoice) => void;
  /** Escape: closes the dialog and sends NOTHING — the server asks again the
   *  next time the office is opened. */
  onDismiss: () => void;
}

/**
 * First-run hooks consent dialog, shared by both surfaces (the VS Code webview
 * and the standalone browser render this same component off the same server
 * message).
 *
 * Fail-closed by construction: only the three buttons send anything, and only
 * `install` / `never` make the server write. Escape dismisses without sending,
 * so an unanswered dialog changes nothing and reappears on the next open.
 * Deliberately NO backdrop-click dismissal — this is a decision surface, and a
 * stray click on the office behind it must not read as an answer.
 */
export function ConsentModal({ headline, disclosure, onChoice, onDismiss }: ConsentModalProps) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onDismiss();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onDismiss]);

  return (
    <div className="absolute inset-0 bg-black/70 flex items-center justify-center z-100">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={headline}
        className="pixel-panel py-20 px-24 max-w-xl leading-[1.4]"
      >
        <div className="text-2xl mb-12 text-accent">{headline}</div>
        {disclosure.split('\n\n').map((paragraph, i) => (
          <p key={i} className="text-base m-0 mb-10">
            {paragraph}
          </p>
        ))}
        <div className="flex items-center justify-end gap-8 mt-16 flex-wrap">
          <Button variant="ghost" size="md" onClick={() => onChoice('never')}>
            Don't Ask Again
          </Button>
          <Button variant="default" size="md" onClick={() => onChoice('notNow')}>
            Not Now
          </Button>
          <Button variant="accent" size="md" onClick={() => onChoice('install')}>
            Install Hooks
          </Button>
        </div>
      </div>
    </div>
  );
}
