/**
 * The loop guard's numbers, in one place for the server (agent/loops.ts) and the bot editor: what the editor shows as
 * the default is what the server really uses.
 *
 * Three equal steps in a row is ordinary work (running the tests again, checking a status): the guard only stops a bot
 * that is really stuck. Ten equal steps, or twenty steps without anything new.
 */
export const LOOP_DEFAULTS = { repeat: 10, idle: 20 } as const;
/** What a bot's own numbers may be: [lowest, highest]. */
export const LOOP_RANGE = { repeat: [2, 1000], idle: [3, 1000] } as const;
