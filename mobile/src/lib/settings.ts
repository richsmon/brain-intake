// Device-level settings: the brain-host base URL (host-agnostic per spec — the
// app never knows which machine answers) and the sessions bearer token (BI-C2 —
// the server mounts the coding-sessions API only when SESSIONS_TOKEN is set).

import AsyncStorage from "@react-native-async-storage/async-storage";

export const DEFAULT_BASE_URL = "http://100.96.207.63:8787";

const BASE_URL_KEY = "brain.baseUrl";
const SESSIONS_TOKEN_KEY = "brain.sessionsToken";

export interface SettingsStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export function makeSettings(store: SettingsStore = AsyncStorage) {
  return {
    async getBaseUrl(): Promise<string> {
      return (await store.getItem(BASE_URL_KEY)) ?? DEFAULT_BASE_URL;
    },
    async setBaseUrl(url: string): Promise<void> {
      await store.setItem(BASE_URL_KEY, url.trim());
    },
    /** Empty string = not configured — the Coding tab explains how to get one. */
    async getSessionsToken(): Promise<string> {
      return (await store.getItem(SESSIONS_TOKEN_KEY)) ?? "";
    },
    async setSessionsToken(token: string): Promise<void> {
      await store.setItem(SESSIONS_TOKEN_KEY, token.trim());
    },
  };
}

export type Settings = ReturnType<typeof makeSettings>;
