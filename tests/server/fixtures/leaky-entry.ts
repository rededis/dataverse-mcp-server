import { registerAllTools } from "../../../src/tools/all.js";

// A server entry point that brings in every tool group, development included.
// The bundle check must refuse it (tests/server/bundle.test.ts).
console.log(registerAllTools);
