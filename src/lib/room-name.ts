const ADJECTIVES = [
  "amber",
  "quiet",
  "cedar",
  "bright",
  "linen",
  "moss",
  "silver",
  "calm",
];

const NOUNS = [
  "harbor",
  "studio",
  "garden",
  "porch",
  "bridge",
  "attic",
  "window",
  "meadow",
];

export const NAME_STORAGE_KEY = "booth:name";

export function suggestRoom(): string {
  const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adjective}-${noun}`;
}

export function normalizeRoom(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

export function isValidRoom(room: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(room);
}

export function normalizeName(input: string): string {
  return input.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 32);
}
