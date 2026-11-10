export const channels = {
  getInfo: 'app:getInfo',
  getSettings: 'settings:get',
  updateSettings: 'settings:update',
  settingsChanged: 'settings:changed',
  openExternal: 'app:openExternal',
} as const;

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type Theme = 'system' | 'light' | 'dark';
export interface Settings {
  [key: string]: JsonValue;
  theme: Theme;
}
export interface SettingsUpdate {
  theme?: Theme;
}
export interface AppInfo {
  version: string;
  dataDir: string;
  platform: NodeJS.Platform;
}

export interface Requests {
  [channels.getInfo]: undefined;
  [channels.getSettings]: undefined;
  [channels.updateSettings]: SettingsUpdate;
  [channels.openExternal]: { url: string };
}
export interface Responses {
  [channels.getInfo]: AppInfo;
  [channels.getSettings]: Settings;
  [channels.updateSettings]: Settings;
  [channels.openExternal]: void;
}
export interface Events {
  [channels.settingsChanged]: Settings;
}
export interface AgentOpsAPI {
  app: { getInfo(): Promise<AppInfo> };
  settings: {
    get(): Promise<Settings>;
    update(update: SettingsUpdate): Promise<Settings>;
  };
  onSettingsChanged(listener: (settings: Settings) => void): () => void;
}
