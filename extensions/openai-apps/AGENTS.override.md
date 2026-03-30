# OpenAI Apps Override

## How To Test

- Run focused bundle tests from the repo root with Vitest: `pnpm exec vitest run --config vitest.config.ts extensions/openai-apps/src/<test-file>.test.ts`
- Run the full bundle unit test slice when the change spans multiple OpenAI Apps files: `pnpm test -- extensions/openai-apps/src`
- Run the live integration harness through the extension entrypoint, not `./scripts/`:
  - `./extensions/openai-apps/integ/test-chatapps-integ.sh simple` for list-tools plus Gmail
  - `./extensions/openai-apps/integ/test-chatapps-integ.sh full` for list-tools plus Gmail, Linear, and Google Calendar read flows
  - `./extensions/openai-apps/integ/test-chatapps-integ.sh write` for Google Calendar write-policy coverage, including `allowDestructiveActions=always` and `allowDestructiveActions=never`
- The live harness writes artifacts under `/tmp/claw-chat-apps/`.

## Review-Ready Handoff

- Before notifying that a job is ready to review, stage all relevant changes and manually run the repo pre-commit hook with `bash git-hooks/pre-commit`.
- If the pre-commit hook reports issues, fix them, restage any updated files, and rerun the hook.
- Do not send the ready-to-review notification until the staged tree passes the pre-commit hook cleanly.

## Integration Harness Notes

- The integration harness runs under the dedicated OpenClaw profile `chatapps-integ`.
- Before running the full integration test, make sure there is reusable `openai-codex` login state in a local OpenClaw profile. The harness will copy that auth into `chatapps-integ` when possible.
- If no reusable `openai-codex` login is available, log in from an OpenClaw profile first, then rerun `./extensions/openai-apps/integ/test-chatapps-integ.sh <mode>`.

## Constant Overrides

- $DOCS_ROOT: `extensions/openai-apps/docs`: any skill using DOCS_ROOT should have it be set to `extensions/openai-apps/docs`
