## What changed

One or two lines: what broke, or what this adds. Label each number *measured*, *verified*, or *assumed*, and say where it came from.

## Proof

`npm run typecheck && npm test && npm run test:gate`

The gate rig runs against a fake router and needs no host, so it belongs in CI. `npm run test:rpc` and `npm run test:pty` are host smokes: the omp CLI, tmux and a live provider. They stay out of CI and are run on the bench, named in the PR when they were.

## Host-smoke needed

No by default. Yes only when the change touches the phase loop, the lease client, the status surface, or the plugin a live OMP session reloads. The lock serializes on the router URL, not the checkout, so a worktree does not buy a second lane.
