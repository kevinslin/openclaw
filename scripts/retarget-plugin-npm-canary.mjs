#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FORK_PLUGIN_CANARY = Object.freeze({
  packageDir: "extensions/arcee",
  packageName: "@kevins8/openclaw-plugin-stable-e2e",
  repository: "kevinslin/openclaw",
  sourcePackageName: "@openclaw/arcee-provider",
  version: "2099.1.33",
});

function fail(message) {
  throw new Error(message);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function retargetForkPluginNpmCanary(rootDir = process.cwd()) {
  const packageDir = path.join(rootDir, FORK_PLUGIN_CANARY.packageDir);
  const packageJsonPath = path.join(packageDir, "package.json");
  const shrinkwrapPath = path.join(packageDir, "npm-shrinkwrap.json");
  const packageJson = readJson(packageJsonPath);
  const shrinkwrap = readJson(shrinkwrapPath);
  const shrinkwrapRoot = shrinkwrap.packages?.[""];

  if (packageJson.name !== FORK_PLUGIN_CANARY.sourcePackageName) {
    fail(
      `canary source package must be ${FORK_PLUGIN_CANARY.sourcePackageName}; found ${packageJson.name ?? "<missing>"}`,
    );
  }
  if (
    shrinkwrap.name !== FORK_PLUGIN_CANARY.sourcePackageName ||
    shrinkwrapRoot?.name !== FORK_PLUGIN_CANARY.sourcePackageName
  ) {
    fail("canary shrinkwrap must start with the expected OpenClaw plugin identity");
  }
  if (
    packageJson.version !== shrinkwrap.version ||
    packageJson.version !== shrinkwrapRoot.version
  ) {
    fail("canary package.json and npm-shrinkwrap.json versions must match before retargeting");
  }
  if (packageJson.openclaw?.install?.npmSpec !== FORK_PLUGIN_CANARY.sourcePackageName) {
    fail("canary openclaw.install.npmSpec must match the expected source package");
  }

  const repositoryUrl = `https://github.com/${FORK_PLUGIN_CANARY.repository}`;
  packageJson.name = FORK_PLUGIN_CANARY.packageName;
  packageJson.version = FORK_PLUGIN_CANARY.version;
  packageJson.repository = { type: "git", url: repositoryUrl };
  packageJson.publishConfig = {
    ...packageJson.publishConfig,
    access: "public",
    registry: "https://registry.npmjs.org/",
  };
  packageJson.openclaw.install.npmSpec = FORK_PLUGIN_CANARY.packageName;
  shrinkwrap.name = FORK_PLUGIN_CANARY.packageName;
  shrinkwrap.version = FORK_PLUGIN_CANARY.version;
  shrinkwrapRoot.name = FORK_PLUGIN_CANARY.packageName;
  shrinkwrapRoot.version = FORK_PLUGIN_CANARY.version;

  writeJson(packageJsonPath, packageJson);
  writeJson(shrinkwrapPath, shrinkwrap);

  return {
    packageDir: FORK_PLUGIN_CANARY.packageDir,
    packageName: FORK_PLUGIN_CANARY.packageName,
    repository: FORK_PLUGIN_CANARY.repository,
    repositoryUrl,
    version: FORK_PLUGIN_CANARY.version,
  };
}

const entrypoint = process.argv[1]
  ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
  : false;
if (entrypoint) {
  try {
    process.stdout.write(`${JSON.stringify(retargetForkPluginNpmCanary())}\n`);
  } catch (error) {
    console.error(
      `retarget-plugin-npm-canary: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
