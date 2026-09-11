# dev-shutdown-test

Integration test for the **Ctrl+C-cleans-up-the-host** behavior of `npm run dev` / `npm run shared-dev` scripts.

## The bug it guards against

Previously the host was spawned with `detached: true, stdio: 'ignore', child.unref()` and the dev script had no signal handler. When the user pressed Ctrl+C, the dev script died but the detached host survived — leaving the port occupied and the user unable to restart without manually killing the orphan.

The fix mirrors `apps/cli/src/main.ts:runServer`'s SIGINT/SIGTERM handling into the dev scripts: track the spawned host child, on signal send SIGINT to it, wait for it to exit, then exit. Drop `detached`/`unref` since they're no longer needed.

## How to run

```bash
# against the installed plugin dev script (requires plugin's node_modules)
node tools/dev-shutdown-test/dev-shutdown-test.mjs

# against a specific script (relative to repo root)
node tools/dev-shutdown-test/dev-shutdown-test.mjs apps/cli/templates/plugin-workspace/scripts/dev.mjs
node tools/dev-shutdown-test/dev-shutdown-test.mjs apps/cli/templates/plugin-workspace/scripts/shared-dev.mjs
```

For the template paths, the test needs `node_modules/@flowot/nx-pn/bin/nx-pn.mjs` reachable relative to the script's `__root` (one level up from `scripts/`). The repo has it at the top-level `node_modules/`, so set up a tiny fixture first:

```bash
mkdir -p .tool/dev-template-test/{node_modules/@flowot,plugins/echo,scripts}
cp -r node_modules/@flowot/nx-pn .tool/dev-template-test/node_modules/@flowot/
cp apps/cli/templates/plugin-workspace/scripts/{dev,shared-dev,build}.mjs .tool/dev-template-test/scripts/
# minimal plugin so startup upload has something to do
mkdir -p .tool/dev-template-test/plugins/echo
printf '{"name":"echo","version":"1.0.0"}\n' > .tool/dev-template-test/plugins/echo/package.json
printf '{"id":"echo","version":"1.0.0","title":"Echo","schemaVersion":1}\n' > .tool/dev-template-test/plugins/echo/manifest.json
echo "export default function(ctx){}" > .tool/dev-template-test/plugins/echo/host.ts
echo "export default function(ctx){return () => null}" > .tool/dev-template-test/plugins/echo/browser.tsx
```

`.tool/` is gitignored — scratch space only.

## What it does

1. Spawn the chosen dev script on an isolated port (14560) and data-dir.
2. Poll `:PORT/api/plugins` until the host reports up (or 60 s).
3. Send SIGINT to the dev script.
4. Wait for the dev script to exit (≤15 s).
5. Probe the port again. If it still responds → host still alive → **FAIL**. Otherwise → host died cleanly → **PASS**.
6. Also verify the dev script itself exited cleanly (no forced kill).

Exit code: `0` = pass, `1` = fail.

## When to run

- After touching `plugins/my-plugin/scripts/dev.mjs` or `apps/cli/templates/plugin-workspace/scripts/{dev,shared-dev}.mjs`.
- When changing anything that affects how the host child is spawned or shut down.