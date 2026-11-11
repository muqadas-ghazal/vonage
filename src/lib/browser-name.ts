import { NAME_STORAGE_KEY, normalizeName } from "./room-name";

const listeners = new Set<() => void>();

export function subscribeName(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function readName(): string | null {
  return normalizeName(window.sessionStorage.getItem(NAME_STORAGE_KEY) ?? "");
}

export function serverName(): string | null {
  return null;
}

export function saveName(name: string) {
  const next = normalizeName(name);
  window.sessionStorage.setItem(NAME_STORAGE_KEY, next);
  for (const listener of listeners) listener();
}
