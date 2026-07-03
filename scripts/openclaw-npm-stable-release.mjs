#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseReleaseVersion } from "./lib/npm-publish-plan.mjs";

const SUPPORTED_DIST_TAGS = new Set(["alpha", "beta", "latest", "stable"]);
const FORK_TEST_REPOSITORY = "kevinslin/openclaw";
const FORK_TEST_BRANCH = "dev/kevinlin/integ-stable-2000-1";
const FORK_TEST_PACKAGE = "@kevins8/openclaw-stable-e2e";

function parseRequiredBoolean(value, name) {
  if (value === "true") {
    return true;
  }
  if (value === "false" || value === "") {
    return false;
  }
  throw new Error(`${name} must be "true" or "false"; got "${value}".`);
}

export function parseStableGuardBypass(value = "") {
  if (value === "" || value === "false") {
    return false;
  }
  if (value === "true") {
    return true;
  }
  throw new Error(`BYPASS_STABLE_GUARD must be "true" or "false"; got "${value}".`);
}

export function validateForkNpmTestContract({
  repository,
  workflowRef,
  packageName,
  forkCoreNpmOnly,
  historicalStableTest,
  bypassStableGuard,
  npmDistTag,
}) {
  const forkRequested =
    repository !== "openclaw/openclaw" ||
    packageName !== "openclaw" ||
    forkCoreNpmOnly ||
    historicalStableTest;
  if (!forkRequested) {
    return { enabled: false, packageName: "openclaw" };
  }
  if (
    repository !== FORK_TEST_REPOSITORY ||
    workflowRef !== `refs/heads/${FORK_TEST_BRANCH}` ||
    packageName !== FORK_TEST_PACKAGE ||
    !forkCoreNpmOnly ||
    !historicalStableTest ||
    !bypassStableGuard ||
    npmDistTag !== "stable"
  ) {
    throw new Error(
      "Fork npm test mode requires the fixed repository, branch, package, stable dist-tag, and boolean inputs.",
    );
  }
  return { enabled: true, packageName, stableBranch: FORK_TEST_BRANCH };
}

function requireStableBypassTag(npmDistTag, bypassStableGuard) {
  if (bypassStableGuard && npmDistTag !== "stable") {
    throw new Error("BYPASS_STABLE_GUARD may only be used with the stable npm dist-tag.");
  }
}

export function validateNpmPublishBoundary(
  packageVersion,
  npmDistTag,
  { bypassStableGuard = false } = {},
) {
  if (!SUPPORTED_DIST_TAGS.has(npmDistTag)) {
    throw new Error(`Unsupported npm dist-tag "${npmDistTag}".`);
  }
  requireStableBypassTag(npmDistTag, bypassStableGuard);
  const parsed = parseReleaseVersion(packageVersion);
  if (parsed === null) {
    throw new Error(`Unsupported release version "${packageVersion}".`);
  }

  if (parsed.channel === "alpha") {
    if (npmDistTag !== "alpha") {
      throw new Error("Alpha prereleases must publish to the alpha npm dist-tag.");
    }
    return parsed;
  }
  if (parsed.channel === "beta") {
    if (npmDistTag !== "beta") {
      throw new Error("Beta prereleases must publish to the beta npm dist-tag.");
    }
    return parsed;
  }

  if (npmDistTag === "stable") {
    if (parsed.correctionNumber !== undefined) {
      throw new Error("Stable npm publication does not allow correction suffixes.");
    }
    if (!bypassStableGuard && parsed.patch < 33) {
      throw new Error("Stable npm publication requires release patch 33 or above.");
    }
    return parsed;
  }
  if (parsed.patch >= 33) {
    throw new Error(
      `Final or correction release patch 33 and above must publish to the stable npm dist-tag; got ${npmDistTag}.`,
    );
  }
  return parsed;
}

export function validateStableNpmReleaseRequest(request) {
  const bypassStableGuard = request.bypassStableGuard ?? false;
  const historicalStableTest = request.historicalStableTest ?? false;
  requireStableBypassTag(request.npmDistTag, bypassStableGuard);
  const taggedVersion = request.releaseTag.startsWith("v")
    ? parseReleaseVersion(request.releaseTag.slice(1))
    : null;

  if (request.npmDistTag !== "stable") {
    if (taggedVersion !== null) {
      validateNpmPublishBoundary(taggedVersion.version, request.npmDistTag, {
        bypassStableGuard,
      });
    } else if (!SUPPORTED_DIST_TAGS.has(request.npmDistTag)) {
      throw new Error(`Unsupported npm dist-tag "${request.npmDistTag}".`);
    }
    return { stable: false };
  }

  if (
    taggedVersion === null ||
    request.releaseTag !== `v${taggedVersion.version}` ||
    taggedVersion.channel !== "stable"
  ) {
    throw new Error("Stable npm publication requires an exact final vYYYY.M.P release tag.");
  }
  validateNpmPublishBoundary(taggedVersion.version, request.npmDistTag, { bypassStableGuard });

  const releaseVersion = taggedVersion.version;
  const stableBranch = historicalStableTest
    ? FORK_TEST_BRANCH
    : `stable/${taggedVersion.year}.${taggedVersion.month}.33`;
  const expectedWorkflowRef = `refs/heads/${stableBranch}`;
  if (request.npmWorkflowRef !== expectedWorkflowRef) {
    throw new Error(
      `Stable npm workflow ref mismatch: expected ${expectedWorkflowRef}, got ${request.npmWorkflowRef}.`,
    );
  }
  if (request.packageVersion !== releaseVersion) {
    throw new Error(
      `Stable npm package version mismatch: expected ${releaseVersion}, got ${request.packageVersion}.`,
    );
  }

  const shaValues = [request.checkoutSha, request.tagSha, request.stableBranchSha];
  if (shaValues.some((sha) => !/^[0-9a-f]{40}$/iu.test(sha))) {
    throw new Error("Stable npm release identity requires full 40-character Git SHAs.");
  }
  if (new Set(shaValues.map((sha) => sha.toLowerCase())).size !== 1) {
    throw new Error("Stable npm checkout, tag, and stable branch tip SHAs must match exactly.");
  }

  if (bypassStableGuard) {
    return {
      stable: true,
      releaseVersion,
      stableBranch,
      bypassStableGuard: true,
      ...(historicalStableTest ? { historicalStableTest: true } : {}),
    };
  }

  const mainVersion = parseReleaseVersion(request.mainPackageVersion);
  if (
    mainVersion === null ||
    mainVersion.channel !== "stable" ||
    mainVersion.correctionNumber !== undefined
  ) {
    throw new Error("Protected main package version must be an exact final YYYY.M.P version.");
  }
  const mainCalendarMonth = mainVersion.year * 12 + mainVersion.month;
  const releaseCalendarMonth = taggedVersion.year * 12 + taggedVersion.month;
  if (mainCalendarMonth <= releaseCalendarMonth) {
    throw new Error(
      `Protected main must be in a later calendar month than ${taggedVersion.year}.${taggedVersion.month}; got ${request.mainPackageVersion}.`,
    );
  }
  if (mainVersion.patch >= 33) {
    throw new Error("Protected main must remain on a daily patch below 33.");
  }
  return { stable: true, releaseVersion, stableBranch };
}

export function validateStableRunIdentity({ run, kind, npmDistTag, expectedBranch, expectedSha }) {
  const expectedWorkflowName =
    kind === "preflight" ? "OpenClaw NPM Release" : "Full Release Validation";
  const checks = [
    ["workflowName", expectedWorkflowName],
    ["event", "workflow_dispatch"],
    ...(kind === "validation" ? [["status", "completed"]] : []),
    ["conclusion", "success"],
  ];
  for (const [key, expected] of checks) {
    if (run[key] !== expected) {
      throw new Error(
        `Referenced ${kind} run must have ${key}=${expected}, got ${run[key] ?? "<missing>"}.`,
      );
    }
  }
  if (
    npmDistTag === "stable" &&
    (run.headBranch !== expectedBranch || run.headSha !== expectedSha)
  ) {
    throw new Error(
      `Referenced stable ${kind} run must have headBranch=${expectedBranch} and headSha=${expectedSha}; got ${run.headBranch ?? "<missing>"} and ${run.headSha ?? "<missing>"}.`,
    );
  }
  return run;
}

export function validateFullReleaseValidationManifest({
  manifest,
  npmDistTag,
  expectedWorkflowRef,
  expectedSha,
}) {
  if (manifest.workflowName !== "Full Release Validation") {
    throw new Error(
      `Full release validation manifest workflow mismatch: ${manifest.workflowName ?? "<missing>"}.`,
    );
  }
  if (manifest.targetSha !== expectedSha) {
    throw new Error(
      `Full release validation target SHA mismatch: expected ${expectedSha}, got ${manifest.targetSha ?? "<missing>"}.`,
    );
  }
  if (npmDistTag === "stable" && manifest.workflowRef !== expectedWorkflowRef) {
    throw new Error(
      `Full release validation workflow ref mismatch: expected ${expectedWorkflowRef}, got ${manifest.workflowRef ?? "<missing>"}.`,
    );
  }
  return manifest;
}

export function parsePriorStableSelector(stdout) {
  let tags;
  try {
    tags = JSON.parse(stdout);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`npm dist-tags query returned invalid JSON: ${message}`, {
      cause: error,
    });
  }
  if (tags === null || typeof tags !== "object" || Array.isArray(tags)) {
    throw new Error("npm dist-tags query did not return a JSON object.");
  }
  if (!Object.hasOwn(tags, "stable")) {
    return "absent";
  }
  if (typeof tags.stable !== "string" || tags.stable.trim() === "") {
    throw new Error("npm stable dist-tag was not a non-empty version string.");
  }
  return tags.stable;
}

export function capturePriorStableSelector({ query }) {
  const result = query();
  if (result.status !== 0) {
    throw new Error(`npm dist-tags query failed with exit code ${result.status ?? "unknown"}.`);
  }
  return parsePriorStableSelector(result.stdout);
}

export async function verifyStableRegistryReadback({
  expectedVersion,
  packageName = "openclaw",
  query,
  sleep,
  attempts = 12,
  delayMs = 10_000,
}) {
  let exactVersion = "missing";
  let stableSelector = "missing";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const exactResult = await query(`${packageName}@${expectedVersion}`);
    const stableResult = await query(`${packageName}@stable`);
    exactVersion = exactResult.status === 0 ? exactResult.stdout.trim() : "missing";
    stableSelector = stableResult.status === 0 ? stableResult.stdout.trim() : "missing";
    if (exactVersion === expectedVersion && stableSelector === expectedVersion) {
      return { exactVersion, stableSelector, attemptsUsed: attempt };
    }
    if (attempt < attempts) {
      await sleep(delayMs);
    }
  }
  throw new Error(
    `npm registry did not converge to ${packageName}@${expectedVersion} and ${packageName}@stable=${expectedVersion} after ${attempts} attempts (exact=${exactVersion}, stable=${stableSelector}).`,
  );
}

export function stableSelectorRepairCommand(previous, packageName = "openclaw") {
  return previous === "absent"
    ? `npm dist-tag rm ${packageName} stable`
    : `npm dist-tag add ${packageName}@${previous} stable`;
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function packageVersionAt(ref) {
  return JSON.parse(git(["show", `${ref}:package.json`])).version;
}

function validateRequestFromRepository() {
  const npmDistTag = process.env.RELEASE_NPM_DIST_TAG ?? "";
  const releaseTag = process.env.RELEASE_TAG ?? "";
  const npmWorkflowRef = process.env.NPM_WORKFLOW_REF ?? "";
  const bypassStableGuard = parseStableGuardBypass(process.env.BYPASS_STABLE_GUARD ?? "");
  const forkCoreNpmOnly = parseRequiredBoolean(
    process.env.FORK_CORE_NPM_ONLY ?? "",
    "FORK_CORE_NPM_ONLY",
  );
  const historicalStableTest = parseRequiredBoolean(
    process.env.HISTORICAL_STABLE_TEST ?? "",
    "HISTORICAL_STABLE_TEST",
  );
  const forkContract = validateForkNpmTestContract({
    repository: process.env.RELEASE_REPOSITORY ?? "openclaw/openclaw",
    workflowRef: npmWorkflowRef,
    packageName: process.env.NPM_PACKAGE_NAME ?? "openclaw",
    forkCoreNpmOnly,
    historicalStableTest,
    bypassStableGuard,
    npmDistTag,
  });
  if (npmDistTag !== "stable") {
    return validateStableNpmReleaseRequest({
      bypassStableGuard,
      npmDistTag,
      releaseTag,
      npmWorkflowRef,
      historicalStableTest: forkContract.enabled,
      checkoutSha: "",
      tagSha: "",
      stableBranchSha: "",
      packageVersion: JSON.parse(readFileSync("package.json", "utf8")).version,
      mainPackageVersion: "",
    });
  }

  const parsed = releaseTag.startsWith("v") ? parseReleaseVersion(releaseTag.slice(1)) : null;
  if (!parsed || parsed.channel !== "stable" || parsed.correctionNumber !== undefined) {
    return validateStableNpmReleaseRequest({
      npmDistTag,
      bypassStableGuard,
      releaseTag,
      npmWorkflowRef,
      historicalStableTest: forkContract.enabled,
      checkoutSha: "",
      tagSha: "",
      stableBranchSha: "",
      packageVersion: JSON.parse(readFileSync("package.json", "utf8")).version,
      mainPackageVersion: "",
    });
  }
  const stableBranch = forkContract.enabled
    ? FORK_TEST_BRANCH
    : `stable/${parsed.year}.${parsed.month}.33`;
  if (bypassStableGuard) {
    execFileSync(
      "git",
      [
        "fetch",
        "--no-tags",
        "origin",
        `+refs/heads/${stableBranch}:refs/remotes/origin/${stableBranch}`,
      ],
      { stdio: "inherit" },
    );
    execFileSync(
      "git",
      ["fetch", "--no-tags", "origin", `+refs/tags/${releaseTag}:refs/tags/${releaseTag}`],
      { stdio: "inherit" },
    );
    return validateStableNpmReleaseRequest({
      npmDistTag,
      bypassStableGuard,
      releaseTag,
      npmWorkflowRef,
      historicalStableTest: forkContract.enabled,
      checkoutSha: git(["rev-parse", "HEAD"]),
      tagSha: git(["rev-parse", `${releaseTag}^{commit}`]),
      stableBranchSha: git(["rev-parse", `refs/remotes/origin/${stableBranch}`]),
      packageVersion: JSON.parse(readFileSync("package.json", "utf8")).version,
      mainPackageVersion: "",
    });
  }
  execFileSync(
    "git",
    [
      "fetch",
      "--no-tags",
      "origin",
      `+refs/heads/${stableBranch}:refs/remotes/origin/${stableBranch}`,
      "+refs/heads/main:refs/remotes/origin/main",
    ],
    { stdio: "inherit" },
  );
  execFileSync(
    "git",
    ["fetch", "--no-tags", "origin", `+refs/tags/${releaseTag}:refs/tags/${releaseTag}`],
    { stdio: "inherit" },
  );
  return validateStableNpmReleaseRequest({
    npmDistTag,
    bypassStableGuard,
    releaseTag,
    npmWorkflowRef,
    historicalStableTest: forkContract.enabled,
    checkoutSha: git(["rev-parse", "HEAD"]),
    tagSha: git(["rev-parse", `${releaseTag}^{commit}`]),
    stableBranchSha: git(["rev-parse", `refs/remotes/origin/${stableBranch}`]),
    packageVersion: JSON.parse(readFileSync("package.json", "utf8")).version,
    mainPackageVersion: packageVersionAt("refs/remotes/origin/main"),
  });
}

function appendOutput(values) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) {
    throw new Error("GITHUB_OUTPUT is required.");
  }
  appendFileSync(
    output,
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );
}

async function main() {
  const command = process.argv[2];
  if (command === "validate-request") {
    const result = validateRequestFromRepository();
    console.log(
      result.stable
        ? `Validated stable npm release ${result.releaseVersion}.`
        : "Validated regular npm release request.",
    );
    return;
  }
  if (command === "publish-plan") {
    const npmDistTag = process.env.REQUESTED_PUBLISH_TAG ?? "";
    const bypassStableGuard = parseStableGuardBypass(process.env.BYPASS_STABLE_GUARD ?? "");
    const parsed = validateNpmPublishBoundary(process.env.PACKAGE_VERSION ?? "", npmDistTag, {
      bypassStableGuard,
    });
    console.log(parsed.channel);
    console.log(npmDistTag);
    return;
  }
  if (command === "verify-run") {
    const run = JSON.parse(readFileSync(0, "utf8"));
    validateStableRunIdentity({
      run,
      kind: process.env.RUN_KIND,
      npmDistTag: process.env.RELEASE_NPM_DIST_TAG,
      expectedBranch: process.env.EXPECTED_STABLE_BRANCH,
      expectedSha: process.env.EXPECTED_RELEASE_SHA,
    });
    console.log(`Verified referenced ${process.env.RUN_KIND} run.`);
    return;
  }
  if (command === "verify-manifest") {
    const manifest = JSON.parse(readFileSync(process.env.MANIFEST_FILE, "utf8"));
    validateFullReleaseValidationManifest({
      manifest,
      npmDistTag: process.env.RELEASE_NPM_DIST_TAG,
      expectedWorkflowRef: process.env.EXPECTED_WORKFLOW_REF,
      expectedSha: process.env.EXPECTED_RELEASE_SHA,
    });
    return;
  }
  if (command === "capture-selector") {
    const packageName = process.env.NPM_PACKAGE_NAME ?? "openclaw";
    const previous = capturePriorStableSelector({
      query: () =>
        spawnSync("npm", ["view", packageName, "dist-tags", "--json"], { encoding: "utf8" }),
    });
    appendOutput({ previous });
    return;
  }
  if (command === "verify-readback") {
    const expectedVersion = (process.env.EXPECTED_VERSION ?? "").replace(/^v/u, "");
    const result = await verifyStableRegistryReadback({
      expectedVersion,
      packageName: process.env.NPM_PACKAGE_NAME ?? "openclaw",
      query: (target) => spawnSync("npm", ["view", target, "version"], { encoding: "utf8" }),
      sleep: (delayMs) =>
        new Promise((resolve) => {
          setTimeout(resolve, delayMs);
        }),
    });
    appendOutput({ exact_version: result.exactVersion, stable_selector: result.stableSelector });
    return;
  }
  if (command === "repair-command") {
    console.log(
      stableSelectorRepairCommand(
        process.env.PREVIOUS_STABLE,
        process.env.NPM_PACKAGE_NAME ?? "openclaw",
      ),
    );
    return;
  }
  throw new Error(`Unknown stable npm release command: ${command ?? "<missing>"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`openclaw-npm-stable-release: ${message}`);
    process.exit(1);
  }
}
