# Running on Replit

This is a Node.js 20 / TypeScript CLI project managed with pnpm.

- Start the CLI with the **Start application** workflow (`pnpm start`).
- Check TypeScript with `pnpm typecheck`.
- Store `ANTHROPIC_API_KEY` as a Replit Secret.
- If the API key is identity-linked, also set the non-secret `ANTHROPIC_WORKSPACE_ID` environment variable. The CLI sends it as the `anthropic-workspace-id` request header.

The CLI performs one Anthropic API call and then exits, so the console workflow finishes after each successful run.