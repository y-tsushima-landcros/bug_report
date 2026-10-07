// Minimal reproduction: Agent.convertTools() retains a fresh copy of every sub-agent's
// tool schemas on each call. The copies are anchored by Zod's global registry, so they
// survive a forced GC and accumulate without bound.
//
//   node --expose-gc repro.mjs                  # with sub-agents  -> leaks
//   node --expose-gc repro.mjs --no-sub-agents  # control          -> does not leak
//
// No API key is required: the model is never invoked.
import { readFileSync } from "node:fs";
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { createAnthropic } from "@ai-sdk/anthropic";
import { z } from "zod";

const WITH_SUB_AGENTS = !process.argv.includes("--no-sub-agents");
const N = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 500);

const model = createAnthropic({ apiKey: "not-used" })("claude-sonnet-4-5");

const mkTool = (id) =>
  createTool({
    id,
    description: `Tool ${id}.`,
    inputSchema: z.object({
      query: z.string().describe("What to look up"),
      limit: z.number().int().min(1).max(50).default(10).describe("How many results"),
      filters: z
        .object({
          category: z.enum(["a", "b", "c"]).describe("Category"),
          since: z.string().optional().describe("ISO date"),
        })
        .optional()
        .describe("Optional filters"),
    }),
    outputSchema: z.object({ results: z.array(z.string()).describe("Hits") }),
    execute: async () => ({ results: [] }),
  });

// The trigger. With `agents: {}` the same loop costs ~1 KB/call and adds nothing
// to the Zod registry.
const subAgents = WITH_SUB_AGENTS
  ? Object.fromEntries(
      ["alpha", "beta", "gamma", "delta"].map((n) => [
        n,
        new Agent({
          name: n,
          instructions: `Desk ${n}.`,
          model,
          tools: { [`${n}_lookup`]: mkTool(`${n}_lookup`) },
        }),
      ]),
    )
  : {};

// Every schema below is constructed ONCE, at module scope. Nothing is rebuilt per call.
const tools = Object.fromEntries([0, 1, 2, 3, 4].map((i) => [`tool_${i}`, mkTool(`tool_${i}`)]));

const agent = new Agent({
  name: "front_desk",
  instructions: "Delegate to the right specialist.",
  model,
  tools: () => tools,
  agents: subAgents,
});

// Zod's global registry. In zod@3.25.x's `zod/v4` shim this is a strong Map (see #18469).
const { globalRegistry } = await import("zod/v4");

const settle = async () => {
  for (let i = 0; i < 4; i++) {
    global.gc();
    await new Promise((r) => setTimeout(r, 40));
  }
};

await agent.convertTools({}); // warm up: let any legitimate one-time caches fill
await settle();
const h0 = process.memoryUsage().heapUsed;
const r0 = globalRegistry._map.size;

for (let i = 0; i < N; i++) await agent.convertTools({});
await settle();
const h1 = process.memoryUsage().heapUsed;
const r1 = globalRegistry._map.size;

const core = JSON.parse(readFileSync("node_modules/@mastra/core/package.json", "utf8")).version;
const zod = JSON.parse(readFileSync("node_modules/zod/package.json", "utf8")).version;
const mb = (b) => (b / 1048576).toFixed(1);

console.log(`@mastra/core ${core}  zod ${zod}  node ${process.version}`);
console.log(`sub-agents: ${Object.keys(subAgents).length}   calls: ${N}   (full GC before each measurement)`);
console.log(`  heap          ${mb(h0)} MB -> ${mb(h1)} MB    (+${((h1 - h0) / N / 1024).toFixed(1)} KB per call)`);
console.log(`  zod registry  ${r0} -> ${r1}    (+${((r1 - r0) / N).toFixed(1)} entries per call)`);
