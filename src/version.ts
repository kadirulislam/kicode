declare const __KICODE_VERSION__: string | undefined;

/**
 * Replaced by tsup's `define` at build time. Running from source (tests, tsx)
 * the identifier is undeclared, which `typeof` reports safely as "undefined".
 */
export const VERSION = typeof __KICODE_VERSION__ === "string" ? __KICODE_VERSION__ : "dev";
