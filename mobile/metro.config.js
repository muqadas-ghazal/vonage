// Monorepo-aware Metro config.
//
// mobile/ is not an npm workspace — it has its own node_modules with nested dependencies
// (expo-asset lives inside expo/node_modules, for instance). So hierarchical lookup must
// stay ON, or Metro cannot see those nested packages at all.
//
// But watching the repo root to pick up the @booth/* packages creates a second problem:
// those packages are symlinked, Metro resolves them to their real path, and their own
// `import "react"` then walks up to the REPO root's react rather than this app's. Two
// copies of React in one bundle breaks hooks at runtime with no build error. So the
// shared singletons are pinned to this app's copies explicitly.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

/** Packages that must resolve to exactly one copy, no matter who imports them. */
const singletons = ["react", "react-dom", "react-native", "react-native-webview"];

// Resolution is redirected by moving the *origin* into this app, not by rewriting the
// module name. Rewriting the name to a file path would bypass each package's "exports"
// map and break subpath imports such as "react-native/react-private-interface".
const appOrigin = path.join(projectRoot, "index.ts");

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const pinned = singletons.some(
    (name) => moduleName === name || moduleName.startsWith(`${name}/`),
  );
  const from = pinned ? { ...context, originModulePath: appOrigin } : context;
  return context.resolveRequest(from, moduleName, platform);
};

module.exports = config;
