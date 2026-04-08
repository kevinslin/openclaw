import { access, constants } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function expandHomePath(command: string, homeDir: string): string {
  if (command === "~") {
    return homeDir;
  }
  if (command.startsWith("~/") || command.startsWith("~\\")) {
    return path.join(homeDir, command.slice(2));
  }
  return command;
}

function isPathLike(command: string): boolean {
  return command.includes("/") || command.includes("\\");
}

function unique(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}

function buildSearchDirs(params: { env?: NodeJS.ProcessEnv; homeDir: string }): string[] {
  const pathDirs = (params.env?.PATH ?? process.env.PATH ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);

  return unique([
    path.join(params.homeDir, ".openai", "bin"),
    path.join(params.homeDir, "Library", "Application Support", "OpenAI", "bin"),
    path.join(params.homeDir, "Applications", "Codex.app", "Contents", "Resources"),
    path.join("/Applications", "Codex.app", "Contents", "Resources"),
    ...pathDirs,
  ]);
}

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveAppServerCommand(params: {
  command: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): Promise<string> {
  const homeDir = params.homeDir ?? params.env?.HOME ?? os.homedir();
  const expandedCommand = expandHomePath(params.command, homeDir);

  if (isPathLike(expandedCommand)) {
    return expandedCommand;
  }

  for (const dir of buildSearchDirs({
    env: params.env,
    homeDir,
  })) {
    const candidate = path.join(dir, expandedCommand);
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }

  return expandedCommand;
}
