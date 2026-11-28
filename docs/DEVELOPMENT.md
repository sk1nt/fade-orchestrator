# Development

Use Node.js 22 or newer. Install dependencies from the lockfile with `npm ci`.

## Build and checks

Run these checks from the repository root.

```bash
npm run typecheck
npm test
npm run test:gate
npm run build
git diff --exit-code -- dist/index.js
```

`dist/index.js` is committed build output. After a source change, regenerate it
and review its diff. CI rebuilds the bundle and requires it to match the committed
file. Unit tests use a separate bundle under `.test-build/`.

The gate rig uses a fake host and stub router. The hostile-load checks can also
be run directly with `node test/load_hostile.mjs`.

Host integration checks require the OMP CLI and, for the terminal rig, tmux.
Inspect their environment requirements before running them.

```bash
npm run test:rpc
npm run test:pty
```

The rigs isolate child session identity so the child can own its test run.
Consult `.github/workflows/ci.yml` for the complete CI checks, including the
public-source provenance sweep and interface assertions.

## Record a demo

Install vhs, tmux, and OMP, then run the recording from the repository root.

```bash
npm run demo:record
npm run demo:stop
```

`FADE_DEMO_REPO` selects the project shown in the recording. It defaults to this
repository. The recorder seeds a demonstration run and uses an isolated stub
router. The interface and extension run in a real terminal. The run data and
router responses are staged for the recording.

The recorder snapshots the run files it touches. `demo:stop` stops its processes,
restores the snapshot, and reports file hash comparisons. Review that output
when recording against a project with existing run state.

Captures are generated under `demo/out/` and remain ignored. The recording source
is `demo/linkedin.tape`.
