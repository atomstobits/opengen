'use client';

import { createContext, useContext, type ReactNode } from 'react';

const PublicOrigin = createContext('https://opengen.dev');

/** Only the validated public origin crosses this boundary; no server credentials. */
export function PublicOriginProvider({
  origin,
  children,
}: {
  origin: string;
  children: ReactNode;
}) {
  return <PublicOrigin.Provider value={origin}>{children}</PublicOrigin.Provider>;
}

export function usePublicOrigin() {
  return useContext(PublicOrigin);
}
