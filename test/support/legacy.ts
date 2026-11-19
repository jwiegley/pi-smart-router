// What an earlier version's local-only pin left behind, named only so that the tests can make a
// session or a process that has it. Nothing under src/ or index.ts names or reads either (John,
// 2026-11-18: no trace of the pin). Test-only; never shipped.

/** The session entry /smart-router local on and off wrote. */
export const PIN_ENTRY = "smart-router.pin";

/** The environment variable that once pinned every session of the process to local models. */
export const ENV_PIN = "PI_SMART_ROUTER_LOCAL_ONLY";
