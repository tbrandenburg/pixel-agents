import { useCallback, useEffect, useReducer } from 'react';

import type { HooksConsentRequest } from '../../../core/src/messages.js';
import { transport } from '../transport/index.js';
import type { ConsentChoice } from './introTourState.js';
import { INTRO_TOUR_IDLE, reduceIntroTour } from './introTourState.js';

/**
 * Everything the App needs to run the Intro, off the wire state
 * useExtensionMessages already tracks. The semantics — which asks survive
 * being mooted, when a hooksStatus is this tour's install verdict — live in
 * the pure reducer (introTourState.ts); this only translates props into
 * events and choices into transport sends.
 *
 * `hooksStatusSeq` rather than `hooksInstalled` drives the verdict: a FAILED
 * install re-reports the same `false` the state already held, so the value
 * never changes and only the message's arrival says the server has answered.
 */
export function useIntroTour(args: {
  consentRequest: HooksConsentRequest | null;
  hooksInstalled: boolean;
  hooksStatusSeq: number;
  dismissConsentRequest: () => void;
}): {
  /** The ask to render, or null while no tour should be up. */
  intro: HooksConsentRequest | null;
  /** The closing step's verdict: the install this tour asked for failed. */
  installFailed: boolean;
  /** A consent-step button click: sends the choice, arms the verdict wait. */
  onChoice: (choice: ConsentChoice) => void;
  /** Every way the tour ends. Sends NOTHING — an unanswered ask must return
   *  on the next open. */
  onClose: () => void;
} {
  const [state, dispatch] = useReducer(reduceIntroTour, INTRO_TOUR_IDLE);

  useEffect(() => {
    dispatch({ kind: 'requestChanged', request: args.consentRequest });
  }, [args.consentRequest]);

  useEffect(() => {
    dispatch({ kind: 'statusArrived', installed: args.hooksInstalled });
    // hooksInstalled is read on the seq bump, deliberately not a dependency:
    // only the ARRIVAL of a hooksStatus may settle the verdict (see above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [args.hooksStatusSeq]);

  const onChoice = useCallback((choice: ConsentChoice) => {
    dispatch({ kind: 'choiceSent', choice });
    transport.send({ type: 'hooksConsentResponse', choice });
  }, []);

  const { dismissConsentRequest } = args;
  const onClose = useCallback(() => {
    dispatch({ kind: 'closed' });
    dismissConsentRequest();
  }, [dismissConsentRequest]);

  return { intro: state.intro, installFailed: state.installFailed, onChoice, onClose };
}
