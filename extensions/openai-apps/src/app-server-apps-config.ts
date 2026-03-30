import type { protocol } from "codex-app-server-sdk";
import { buildDerivedAppsConfig, hashChatgptAppsConfig, type ChatgptAppsConfig } from "./config.js";

type ConfigValueWriteParams = protocol.v2.ConfigValueWriteParams;
type ConfigWriteResponse = protocol.v2.ConfigWriteResponse;

export type AppServerAppsConfigWriteGate = {
  runOnce(configHash: string, write: () => Promise<void>): Promise<boolean>;
};

export function createAppServerAppsConfigWriteGate(): AppServerAppsConfigWriteGate {
  let readyConfigHash: string | null = null;
  let pendingWrite: {
    configHash: string;
    promise: Promise<void>;
  } | null = null;

  return {
    async runOnce(configHash, write) {
      while (true) {
        if (readyConfigHash === configHash) {
          return false;
        }

        if (pendingWrite) {
          const currentWrite = pendingWrite;
          try {
            await currentWrite.promise;
          } catch {
            // Retry below if the in-flight write failed.
          }
          if (currentWrite.configHash === configHash && readyConfigHash === configHash) {
            return false;
          }
          continue;
        }

        const promise = (async () => {
          await write();
          readyConfigHash = configHash;
        })();
        pendingWrite = { configHash, promise };
        try {
          await promise;
          return true;
        } finally {
          if (pendingWrite?.promise === promise) {
            pendingWrite = null;
          }
        }
      }
    },
  };
}

export async function writeDerivedAppsConfig(params: {
  config: ChatgptAppsConfig;
  writeConfigValue: (params: ConfigValueWriteParams) => Promise<ConfigWriteResponse>;
  appsConfigWriteGate?: AppServerAppsConfigWriteGate;
}): Promise<boolean> {
  const write = async () => {
    await params.writeConfigValue({
      keyPath: "apps",
      value: buildDerivedAppsConfig(params.config),
      mergeStrategy: "replace",
      expectedVersion: null,
    });
  };

  if (!params.appsConfigWriteGate) {
    await write();
    return true;
  }

  return await params.appsConfigWriteGate.runOnce(hashChatgptAppsConfig(params.config), write);
}
