import { build, type BuildOptions } from "esbuild";

const shared: BuildOptions = {
  bundle: true,
  minify: true,
  platform: "node",
  target: "node24",
  format: "esm",
  banner: {
    js: 'import { createRequire } from "node:module";',
  },
};

await Promise.all([
  build({
    ...shared,
    entryPoints: ["src/index.ts"],
    outfile: "dist/index.js",
  }),
  build({
    ...shared,
    entryPoints: ["src/post.ts"],
    outfile: "dist/post.js",
  }),
]);
