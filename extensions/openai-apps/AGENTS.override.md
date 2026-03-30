# OpenAI Apps Override

## How To Test

- Run the bundle test suite with Vitest: `pnpm test -- extensions/openai-apps/src`
- Run the live integration harness in full mode: `./scripts/test-chatapps-integ.sh full`

## Review-Ready Handoff

- Before notifying that a job is ready to review, stage all relevant changes and manually run the repo pre-commit hook with `bash git-hooks/pre-commit`.
- If the pre-commit hook reports issues, fix them, restage any updated files, and rerun the hook.
- Do not send the ready-to-review notification until the staged tree passes the pre-commit hook cleanly.

## Integration Harness Notes

- The integration harness runs under the dedicated OpenClaw profile `chatapps-integ`.
- Before running the full integration test, make sure there is reusable `openai-codex` login state in a local OpenClaw profile. The harness will copy that auth into `chatapps-integ` when possible.
- If no reusable `openai-codex` login is available, log in from an OpenClaw profile first, then rerun `./scripts/test-chatapps-integ.sh full`.

## Constant Overrides

- $DOCS_ROOT: `extensions/openai-apps/docs`: any skill using DOCS_ROOT should have it be set to `extensions/openai-apps/docs`
