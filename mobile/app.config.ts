import type { ExpoConfig } from "expo/config";

import base from "./app.json";

/**
 * Lets the call URL come from the environment so the same build can point at production,
 * a preview deployment, or a dev server on the LAN:
 *
 *   BOOTH_CALL_URL=https://booth-xyz.vercel.app npx expo start
 */
const defineConfig = (): ExpoConfig => {
  // A JSON import widens the plugin tuples to plain arrays, which no longer match
  // ExpoConfig's `[string, options]` shape. The file's contents are correct; only the
  // inferred type is lossy.
  const config = (base as unknown as { expo: ExpoConfig }).expo;
  return {
    ...config,
    extra: {
      ...config.extra,
      callUrl: process.env.BOOTH_CALL_URL ?? "",
      room: process.env.BOOTH_ROOM ?? "mobile-test",
    },
  };
};

export default defineConfig;
