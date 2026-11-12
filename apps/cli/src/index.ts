export * from "@mdcms/shared";
export * from "./lib/config.js";
// Re-exported so mdcms.config.ts can import `z` from "@mdcms/cli" and always
// use the same Zod instance as the CLI, without its own zod dependency.
export { z } from "zod";
