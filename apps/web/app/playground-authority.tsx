'use client';
import { createContext, useContext } from 'react';

/** Expected scope guards a cookie switch between a browser authority check and an API request. */
export const PlaygroundAuthority = createContext<Record<string, string>>({});
export const usePlaygroundAuthority = () => useContext(PlaygroundAuthority);
