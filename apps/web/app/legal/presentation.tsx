'use client';

import { createContext, createElement, useContext, type ReactNode } from 'react';

export type LegalSurfaceMode = 'draft' | 'staged' | 'published';

export interface LegalSurfacePresentation {
  readonly mode: LegalSurfaceMode;
  readonly publishedAt: string | null;
  readonly effectiveAt: string | null;
}

export const DEFAULT_LEGAL_PRESENTATION: LegalSurfacePresentation = Object.freeze({
  mode: 'draft',
  publishedAt: null,
  effectiveAt: null,
});

const LegalPresentationContext = createContext<LegalSurfacePresentation>(
  DEFAULT_LEGAL_PRESENTATION,
);

/** Only public publication status/timestamps cross this boundary; never server credentials. */
export function LegalPresentationProvider({
  presentation,
  children,
}: {
  presentation: LegalSurfacePresentation;
  children: ReactNode;
}) {
  return createElement(LegalPresentationContext.Provider, { value: presentation }, children);
}

export function useLegalPresentation(): LegalSurfacePresentation {
  return useContext(LegalPresentationContext);
}
