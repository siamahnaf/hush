import * as esbuild from "esbuild";
import { existsSync, readFileSync } from "node:fs";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

//Env
function loadEnv(file) {
  const env = {};
  if (!existsSync(file)) return env;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match) env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return env;
}

const env = { ...loadEnv(".env"), ...process.env };
const clientId = env.HUSH_GOOGLE_CLIENT_ID ?? "";
const clientSecret = env.HUSH_GOOGLE_CLIENT_SECRET ?? "";

if (production && (!clientId || !clientSecret)) {
  console.error("Missing HUSH_GOOGLE_CLIENT_ID or HUSH_GOOGLE_CLIENT_SECRET. Add them to .env or your shell.");
  process.exit(1);
}

//Build
const ctx = await esbuild.context({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  outfile: "dist/extension.js",
  external: ["vscode"],
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  logLevel: "info",
  define: {
    __HUSH_CLIENT_ID__: JSON.stringify(clientId),
    __HUSH_CLIENT_SECRET__: JSON.stringify(clientSecret),
  },
});

if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
