/**
 * The `@lobbify/anvil` type spine — the contract every later stage builds on.
 *
 * Re-exports the core vocabulary and the error taxonomy. Import types from here
 * (or from the package root) rather than reaching into individual files.
 */

export * from "./core.js";
export * from "./errors.js";
