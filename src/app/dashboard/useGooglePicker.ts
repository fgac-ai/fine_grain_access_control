"use client";

import { useState, useCallback, useEffect, useRef } from 'react';
import { useUser, useReverification } from '@clerk/nextjs';
import { isReverificationCancelledError } from '@clerk/nextjs/errors';
import { usePostHog } from 'posthog-js/react';
import { startGoogleReconnect, type ClerkUserLike } from './googleReconnect';
import { DRIVE_FILE_KINDS, type DriveFileKind } from '@/lib/driveFileKinds';

declare global {
  interface Window {
    gapi: any;
    google: any;
  }
}

export interface PickedSheet {
  id: string;
  name: string;
}

/** Kind-neutral alias — a picked file of any DriveFileKind. */
export type PickedFile = PickedSheet;

/**
 * What the consumer learns when the user closes the Picker without a pick.
 * `attempt` counts Picker opens in this page session (1 = first open);
 * `elapsedMs` is open → cancel; `fromOAuthReturn` marks the auto-reopen after
 * the drive.file consent round-trip.
 */
export interface PickerCancelInfo {
  attempt: number;
  elapsedMs: number;
  fromOAuthReturn: boolean;
}

export interface GooglePickerOptions {
  /**
   * Called on Google's CANCEL action. Before 2026-09 a cancel was invisible to
   * the consumer, so the approve page stayed exactly as it was — no message,
   * no name, no visible way back in — and a third of Picker opens ended there.
   */
  onCancelled?: (info: PickerCancelInfo) => void;
}

/**
 * Google Picker flow for exposing per-file grants (sheets by default; pass a
 * `kind` for docs — the view, dialog title, and copy follow the kind).
 *
 * `context` is an opaque string (e.g. a profile id) carried through the whole
 * flow — including the OAuth consent redirect — and handed back to
 * `onSheetsPicked`, so callers know which profile the exposure was for.
 *
 * First-time-grant round trip: the consent redirect returns to the SAME page
 * (`location.pathname`), and the auto-open effect re-launches the picker there.
 * On that return leg we retry the token fetch while Clerk propagates the new
 * scope, and never redirect to consent a second time (no loops). The kind
 * rides the round trip in `pickerKind`, so the auto-reopened picker shows the
 * same view the user started from.
 */
let gapiPickerReady: Promise<void> | null = null;
function loadGapiPicker(): Promise<void> {
  if (!gapiPickerReady) {
    gapiPickerReady = new Promise<void>(resolve => {
      const loadPicker = () => window.gapi.load('picker', () => resolve());
      if (window.gapi) { loadPicker(); return; }
      const script = document.createElement('script');
      script.src = 'https://apis.google.com/js/api.js';
      script.onload = loadPicker;
      document.body.appendChild(script);
    });
  }
  return gapiPickerReady;
}

export function useGooglePicker(
  onSheetsPicked: (sheets: PickedFile[], context?: string) => void,
  kind: DriveFileKind = 'sheet',
  options: GooglePickerOptions = {},
) {
  const kindDesc = DRIVE_FILE_KINDS[kind];
  const { user } = useUser();
  const posthog = usePostHog();
  const [isLoading, setIsLoading] = useState(false);
  const [gapiLoaded, setGapiLoaded] = useState(false);
  // Ref, not a dependency: consumers pass inline callbacks, and a fresh
  // openPickerFlow per render would re-run the auto-open effect.
  const onCancelledRef = useRef(options.onCancelled);
  useEffect(() => { onCancelledRef.current = options.onCancelled; });
  // Per-page-session Picker open counter + open timestamp, so a cancel can be
  // told apart as "first look" vs "came back and gave up again" in analytics.
  const attemptRef = useRef(0);
  const openedAtRef = useRef(0);
  // A failed flow must SAY so — a button that silently does nothing sent a
  // real user away (2026-08-19). Consumers render this next to the trigger.
  const [pickerError, setPickerError] = useState<string | null>(null);

  const RECONNECT_ADVICE =
    'Google authorization could not start. Reconnect your Google account from Dashboard → Accounts, then come back to this link and try again.';

  const failFlow = useCallback((stage: string, err: unknown, advice: string) => {
    const message = err instanceof Error ? err.message : String(err ?? 'unknown error');
    console.error(`[picker] ${stage}:`, err);
    posthog?.capture('picker_flow_error', { stage, message });
    setPickerError(advice);
    setIsLoading(false);
  }, [posthog]);

  // Load the Google API script + picker module ONCE per page, however many
  // hook instances mount (one per file kind on the dashboard). A per-instance
  // loader raced: every instance mounted while `window.gapi` was still
  // undefined appended its own script, and a late-mounting instance that saw
  // `window.gapi` present skipped `gapi.load('picker')` entirely — a dead
  // "Expose" button.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let cancelled = false;
    loadGapiPicker().then(() => { if (!cancelled) setGapiLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  const openPickerFlow = useCallback(async (context?: string, fromOAuthReturn = false) => {
    if (!user) return;
    setPickerError(null);
    setIsLoading(true);

    try {
      // 1. Fetch token and scope info from the backend token bridge. When we
      // just returned from consent, Clerk may not have propagated the new
      // scope yet — poll briefly instead of concluding it's missing.
      const fetchToken = async () => {
        const res = await fetch('/api/auth/google-picker-token');
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to fetch Google OAuth token.');
        return data;
      };

      // A broken/expired Google grant makes the token bridge FAIL outright —
      // and the reconnect leg below is exactly the repair for that. Entering
      // it on failure breaks the circular dependency that used to kill the
      // flow at step 1 ("No Google account connected or missing token",
      // observed 2026-08-19: the user's only symptom was a dead button).
      let tokenData: { hasDriveFileScope?: boolean; accessToken?: string; appId?: string };
      try {
        tokenData = await fetchToken();
      } catch (err) {
        if (fromOAuthReturn) {
          failFlow('token_after_oauth', err,
            'Google did not return a usable authorization. Reconnect your Google account from Dashboard → Accounts, then come back to this link and try again.');
          return;
        }
        console.warn('[picker] token bridge failed — routing into Google reconnect:', err);
        tokenData = { hasDriveFileScope: false };
      }
      if (fromOAuthReturn && !tokenData.hasDriveFileScope) {
        for (let attempt = 0; attempt < 4 && !tokenData.hasDriveFileScope; attempt++) {
          await new Promise(r => setTimeout(r, 1500));
          try { tokenData = await fetchToken(); } catch { /* keep polling; final state handled below */ }
        }
      }

      const existingGoogleAccount = user.externalAccounts.find(
        acc => acc.provider === 'google' || (acc.provider as any) === 'oauth_google'
      );

      // 2. If drive.file scope is missing, trigger Clerk reauthorization.
      // Never from the OAuth return leg — that would loop.
      if (!tokenData.hasDriveFileScope) {
        if (fromOAuthReturn) {
          failFlow('oauth_return_scope_missing', 'drive.file still missing after consent',
            `Google did not grant ${kindDesc.productName} access on that pass — this usually means the consent screen was closed early, or a second authorization round is needed. Click the pick button again to retry; if it keeps happening, reconnect Google from Dashboard → Accounts.`);
          return;
        }

        // Return to the page the user is on, and re-open the picker there.
        // Existing query params ride along — the approve page's signed token
        // must survive the consent round-trip or the flow dead-ends.
        const params = new URLSearchParams(window.location.search);
        params.set('autoOpenPicker', 'true');
        params.set('pickerKind', kind);
        if (context) params.set('pickerContext', context);
        const autoRedirectUrl = `${window.location.origin}${window.location.pathname}?${params.toString()}`;

        // The consent round-trip is the funnel's riskiest hop — a redirect with
        // no subsequent picker_opened is a user who never came back. Captured
        // BEFORE the await so the event can't be lost mid-redirect.
        posthog?.capture('picker_scope_redirect', { kind });
        try {
          window.location.href = await startGoogleReconnect(
            user as unknown as ClerkUserLike, autoRedirectUrl,
          );
        } catch (err) {
          failFlow('google_reauthorize', err, RECONNECT_ADVICE);
        }
        return;
      }

      // 3. Launch Google Picker
      if (!window.gapi || !window.google) {
        failFlow('gapi_not_loaded', 'window.gapi/google missing',
          'The Google Picker script has not finished loading — wait a moment and click again. If it persists, check for content blockers on apis.google.com.');
        return;
      }

      const fallbackNoun = kindDesc.nounCap;
      const pickerCallback = (data: any) => {
        if (data.action === window.google.picker.Action.PICKED) {
          const docs = data.docs.map((doc: any) => ({
            id: doc.id,
            name: doc.name || `${fallbackNoun} (${doc.id.slice(0, 6)})`
          }));
          posthog?.capture('picker_picked', { kind, count: docs.length });
          onSheetsPicked(docs, context);
        } else if (data.action === window.google.picker.Action.CANCEL) {
          const info: PickerCancelInfo = {
            attempt: attemptRef.current,
            elapsedMs: Math.max(0, Date.now() - openedAtRef.current),
            fromOAuthReturn,
          };
          posthog?.capture('picker_cancelled', {
            kind, attempt: info.attempt, elapsed_ms: info.elapsedMs, from_oauth_return: fromOAuthReturn,
          });
          onCancelledRef.current?.(info);
        }
        setIsLoading(false);
      };

      // Two views, not one. The first is the flat "every <kind> I can open"
      // list the Picker always showed (My Drive + shared-with-me, searchable;
      // a DocsView with no options renders like the base View). The second
      // is the only way the Picker lists shared-drive files: the base View
      // has no switch for them, and only DocsView.setEnableDrives(true) shows
      // them (Picker reference). It must be a SEPARATE view — a single view
      // with drives enabled roots the dialog at "Shared drives" and hides My
      // Drive entirely (measured 2026-09-09: a personal account opened to
      // "No documents." and could only reach its own files by search). Why it
      // matters: on 2026-09-07 a Workspace-domain user opened the docs Picker
      // seven times (approve page, profile, Accounts) and cancelled each
      // within 4–12 s without typing a search — a file in a shared drive could
      // not have been listed for them. Folders in the drives view are
      // navigable only (setSelectFolderEnabled stays off).
      const viewId = window.google.picker.ViewId[kindDesc.pickerViewId];
      const filesView = new window.google.picker.DocsView(viewId);
      const sharedDrivesView = new window.google.picker.DocsView(viewId)
        .setEnableDrives(true)
        .setIncludeFolders(true);
      const builder = new window.google.picker.PickerBuilder()
        .addView(filesView)
        .addView(sharedDrivesView)
        .setOAuthToken(tokenData.accessToken)
        .setCallback(pickerCallback)
        .setTitle(kindDesc.pickerTitle)
        .enableFeature(window.google.picker.Feature.MULTISELECT_ENABLED);

      // Without the Cloud project number, a drive.file pick is cosmetic:
      // Google never registers the per-file grant and every later API call on
      // the picked sheet 404s. The token bridge derives it from the token.
      if (tokenData.appId) {
        builder.setAppId(tokenData.appId);
      } else {
        console.warn('Picker running without appId — drive.file grants may not register.');
      }

      const picker = builder.build();

      attemptRef.current += 1;
      openedAtRef.current = Date.now();
      posthog?.capture('picker_opened', { kind, from_oauth_return: fromOAuthReturn, attempt: attemptRef.current });
      picker.setVisible(true);
    } catch (err) {
      failFlow('open_picker', err,
        'Something went wrong opening the Google Picker. Retry the pick button; if it keeps failing, reconnect Google from Dashboard → Accounts and then return to this link.');
    }
  }, [user, onSheetsPicked, failFlow, kind, kindDesc, posthog]);

  // Automatically launch Google Picker if returning from OAuth reauthorization
  // redirect. The component consuming this hook must live on the page the
  // redirect returns to (openPickerFlow redirects to location.pathname, so it
  // does as long as the triggering component initiated the flow).
  useEffect(() => {
    if (typeof window === 'undefined' || !user || !gapiLoaded) return;
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('autoOpenPicker') === 'true') {
      // Kind-scoped: a page can host pickers for several kinds; only the
      // instance the consent round-trip started from re-opens. Absent param
      // = pre-docs link → sheet (the only kind that existed).
      const returnKind = (urlParams.get('pickerKind') ?? 'sheet') as DriveFileKind;
      if (returnKind !== kind) return;
      const context = urlParams.get('pickerContext') ?? undefined;
      // Consume only our params; anything else (e.g. the approve page's
      // token) must survive the cleanup.
      urlParams.delete('autoOpenPicker');
      urlParams.delete('pickerContext');
      urlParams.delete('pickerKind');
      const rest = urlParams.toString();
      const newUrl = `${window.location.pathname}${rest ? `?${rest}` : ''}`;
      window.history.replaceState({}, document.title, newUrl);
      // Auto-launch picker; fromOAuthReturn tolerates scope-propagation lag
      openPickerFlow(context, true);
    }
  }, [user, gapiLoaded, openPickerFlow, kind]);

  const enhancedOpenPicker = useReverification(openPickerFlow);

  const triggerAddSheets = async (context?: string) => {
    try {
      await enhancedOpenPicker(context);
    } catch (err) {
      if (!isReverificationCancelledError(err)) {
        failFlow('trigger', err,
          'Something went wrong starting the Google flow. Retry the pick button; if it keeps failing, reconnect Google from Dashboard → Accounts and then return to this link.');
      } else {
        setIsLoading(false);
      }
    }
  };

  return {
    triggerAddSheets,
    isLoading,
    gapiLoaded,
    pickerError
  };
}
