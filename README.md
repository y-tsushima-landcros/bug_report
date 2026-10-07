# `Agent.convertTools()` heap leak with sub-agents

Minimal reproduction for a leak in `@mastra/core`: **`Agent.convertTools()` retains a fresh
copy of every sub-agent's tool schemas on each call.** The copies are anchored by Zod's
global registry, so they survive a forced GC and accumulate without bound.

Same mechanism as **#18469** (fixed in **#18566**), but on a different code path —
`getSubAgentToolSchemas()` is correctly cached and is *not* the leak here.

## Run it

```bash
npm install
npm run repro      # with sub-agents  -> leaks
npm run control    # same code, agents: {}  -> does not leak
```

No API key is needed. The model is never invoked.

## Expected output

```
$ npm run repro
@mastra/core 1.74.0  zod 3.25.76  node v26.1.0
sub-agents: 4   calls: 500   (full GC before each measurement)
  heap          72.8 MB -> 154.9 MB    (+168.1 KB per call)
  zod registry  475 -> 6475    (+12.0 entries per call)

$ npm run control
@mastra/core 1.74.0  zod 3.25.76  node v26.1.0
sub-agents: 0   calls: 500   (full GC before each measurement)
  heap          72.0 MB -> 72.5 MB    (+1.0 KB per call)
  zod registry  448 -> 448    (+0.0 entries per call)
```

The only difference between the two runs is `agents: subAgents` vs `agents: {}`.

`--expose-gc` forces a full GC before each measurement, so everything counted is reachable.

## Notes

- Every schema in `repro.mjs` is constructed **once, at module scope**. Nothing is rebuilt
  per call by the reproduction itself.
- `getToolsForExecution()` calls `convertTools()`, so it leaks identically.
- `zod` resolves to `3.25.76`, so `zod/v4` is the compatibility shim whose metadata registry
  is a strong `Map`. `@mastra/core`'s peer range is `^3.25.0 || ^4.0.0`.

## Affected versions

Every version tested leaks. The per-call cost increased ~1.67× at **1.68.0**.

| `@mastra/core` | per call | registry entries per call |
|---|---|---|
| 1.74.0 (`latest`) | 171,407 B | +12 |
| 1.69.0 | 172,040 B | +12 |
| 1.68.0 | 171,749 B | +12 |
| 1.67.0 | 103,703 B | +8 |
| 1.61.0 | 103,118 B | +8 |

## Which call is responsible

Same harness, 500 calls each, `@mastra/core` 1.74.0, agent with 4 sub-agents:

| method | per call | registry |
|---|---|---|
| `listTools()` | 53–94 B | +0 |
| `listToolsets({})` | 26–33 B | +0 |
| `getSubAgentToolSchemas()` | 2–4 B | +0 |
| `formatTools({})` | 3–14 B | +0 |
| **`convertTools({})`** | **171,407 B** | **+12** |
| **`getToolsForExecution({})`** | 171,021 B | +12 |
