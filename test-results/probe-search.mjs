import { webSearchTool } from "../dist/tools/web-search.js";
const r = await webSearchTool.execute(
  { query: "TypeScript agent framework", num_results: 3 },
  { session: {}, cwd: process.cwd(), env: {}, plan_mode: false }
);
console.log("is_error:", r.is_error);
console.log(r.output);
