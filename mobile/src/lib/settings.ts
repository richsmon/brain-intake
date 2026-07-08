// Device-level settings. v1 holds exactly one: the brain-host base URL
// (host-agnostic per spec — the app never knows which machine answers).

import AsyncStorage from "@react-native-async-storage/async-storage";

export const DEFAULT_BASE_URL = "http://100.96.207.63:8787";

const BASE_URL_KEY = "brain.baseUrl";

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
  };
}

export type Settings = ReturnType<typeof makeSettings>;
