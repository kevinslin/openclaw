#!/usr/bin/env -S node --import tsx
// Openclaw Npm Prepublish Verify script supports OpenClaw repository automation.

import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { formatErrorMessage } from "../src/infra/errors.ts";
import { runNpmVerifyCommand } from "./lib/npm-verify-exec.ts";
import { runInstalledWorkspaceBootstrapSmoke } from "./lib/workspace-bootstrap-smoke.mjs";
import {
  collectInstalledPackageErrors,
  normalizeInstalledBinaryVersion,
  resolveInstalledBinaryCommandInvocation,
} from "./openclaw-npm-postpublish-verify.ts";
import { resolveNpmCommandInvocation } from "./openclaw-npm-release-check.ts";

type InstalledPackageJson = {
  name?: string;
  version?: string;
};

export type OpenClawNpmPrepublishVerifyArgs =
  | {
      expectedVersion?: string;
      expectedPackageName?: string;
      help: false;
      tarballPath: string;
    }
  | {
      expectedVersion?: undefined;
      expectedPackageName?: undefined;
      help: true;
      tarballPath: "";
    };

export function openClawNpmPrepublishVerifyUsage(): string {
  return "Usage: node --import tsx scripts/openclaw-npm-prepublish-verify.ts <tarball.tgz> [expected-version] [expected-package-name]";
}

export function parseOpenClawNpmPrepublishVerifyArgs(
  argv: readonly string[],
): OpenClawNpmPrepublishVerifyArgs {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const tarballPath = args[0]?.trim() ?? "";
  if (tarballPath === "--help" || tarballPath === "-h") {
    return { help: true, tarballPath: "" };
  }
  if (!tarballPath) {
    throw new Error(openClawNpmPrepublishVerifyUsage());
  }
  if (tarballPath.startsWith("-")) {
    throw new Error(`Unknown openclaw npm prepublish verifier option: ${tarballPath}`);
  }

  const expectedVersion = args[1]?.trim();
  if (expectedVersion?.startsWith("-")) {
    throw new Error(`Unknown openclaw npm prepublish verifier option: ${expectedVersion}`);
  }
  const expectedPackageName = args[2]?.trim();
  if (expectedPackageName?.startsWith("-")) {
    throw new Error(`Unknown openclaw npm prepublish verifier option: ${expectedPackageName}`);
  }
  const extraArg = args[3]?.trim();
  if (extraArg) {
    throw new Error(`Unexpected openclaw npm prepublish verifier argument: ${extraArg}`);
  }

  return {
    ...(expectedVersion ? { expectedVersion } : {}),
    ...(expectedPackageName ? { expectedPackageName } : {}),
    help: false,
    tarballPath,
  };
}

function installedPackagePathSegments(packageName: string): string[] {
  if (packageName === "openclaw") {
    return [packageName];
  }
  if (!/^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/u.test(packageName)) {
    throw new Error(`invalid expected npm package name: ${packageName}`);
  }
  return packageName.split("/");
}

function npmExec(args: string[], cwd: string): string {
  const invocation = resolveNpmCommandInvocation({
    npmArgs: args,
    npmExecPath: process.env.npm_execpath,
    nodeExecPath: process.execPath,
    platform: process.platform,
  });

  return runNpmVerifyCommand(invocation, cwd);
}

function main(argv = process.argv.slice(2)): void {
  const args = parseOpenClawNpmPrepublishVerifyArgs(argv);
  if (args.help) {
    console.log(openClawNpmPrepublishVerifyUsage());
    return;
  }

  const workingDir = mkdtempSync(join(tmpdir(), "openclaw-prepublish-"));
  const prefixDir = join(workingDir, "prefix");
  try {
    npmExec(
      [
        "install",
        "-g",
        "--prefix",
        prefixDir,
        realpathSync(args.tarballPath),
        "--no-fund",
        "--no-audit",
      ],
      workingDir,
    );
    const globalRoot = npmExec(["root", "-g", "--prefix", prefixDir], workingDir);
    const expectedPackageName = args.expectedPackageName || "openclaw";
    const packageRoot = join(globalRoot, ...installedPackagePathSegments(expectedPackageName));
    const pkg = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf8"),
    ) as InstalledPackageJson;
    const resolvedExpectedVersion = args.expectedVersion || pkg.version?.trim() || "";
    const errors = collectInstalledPackageErrors({
      expectedVersion: resolvedExpectedVersion,
      installedVersion: pkg.version?.trim() ?? "",
      packageRoot,
    });
    if (pkg.name !== expectedPackageName) {
      errors.push(
        `installed npm package name mismatch: expected ${expectedPackageName}, found ${pkg.name || "<missing>"}.`,
      );
    }
    const binaryInvocation = resolveInstalledBinaryCommandInvocation(prefixDir, ["--version"]);
    const installedBinaryVersion = runNpmVerifyCommand(binaryInvocation, workingDir);
    if (normalizeInstalledBinaryVersion(installedBinaryVersion) !== resolvedExpectedVersion) {
      errors.push(
        `installed openclaw binary version mismatch: expected ${resolvedExpectedVersion}, found ${installedBinaryVersion || "<missing>"}.`,
      );
    }
    if (errors.length === 0) {
      runInstalledWorkspaceBootstrapSmoke({ packageRoot });
    }
    if (errors.length > 0) {
      throw new Error(`prepared tarball install failed:\n- ${errors.join("\n- ")}`);
    }
    console.log(
      `openclaw-npm-prepublish-verify: prepared tarball install OK (${resolvedExpectedVersion}).`,
    );
  } finally {
    rmSync(workingDir, { force: true, recursive: true });
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint !== null && import.meta.url === entrypoint) {
  try {
    main();
  } catch (error) {
    console.error(`openclaw-npm-prepublish-verify: ${formatErrorMessage(error)}`);
    process.exitCode = 1;
  }
}
