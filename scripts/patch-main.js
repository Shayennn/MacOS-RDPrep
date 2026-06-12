#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { installBootstrap } = require("./install-bootstrap");

function usage(exitCode) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write("Usage: node scripts/patch-main.js <path-to-main.js-or-app-dir>\n");
  process.exit(exitCode);
}

function resolveAppDir(inputPath) {
  if (!inputPath) {
    usage(1);
  }

  const resolvedPath = path.resolve(inputPath);

  if (path.basename(resolvedPath) === "main.js" || path.extname(resolvedPath) === ".js") {
    return path.dirname(resolvedPath);
  }

  return resolvedPath;
}

function main(argv) {
  const inputPath = argv[2];

  if (inputPath === "-h" || inputPath === "--help") {
    usage(0);
  }

  try {
    const appDir = resolveAppDir(inputPath);
    const result = installBootstrap(appDir);

    console.log("Version-agnostic bootstrap installed.");
    console.log(`  app: ${result.appDir}`);
    console.log(`  bootstrap: ${result.bootstrapFile}`);
    console.log(`  runtime: ${result.runtimeEntry}`);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    console.error(`patch-main compatibility wrapper failed: ${message}`);
    process.exit(1);
  }
}

main(process.argv);
