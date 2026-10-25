/**
 * Case registry for the differential test battery (scripts/diff-test.mjs).
 * Each module owns one family; the harness runs every case against every
 * selected endpoint in this order.
 */
import { PUSH_CASES } from "./cases-push.mjs";
import { PROTOCOL_CASES } from "./cases-protocol.mjs";
import { READ_CASES } from "./cases-read.mjs";
import { WRITE_CASES } from "./cases-write.mjs";

export const CASES = [...READ_CASES, ...WRITE_CASES, ...PROTOCOL_CASES, ...PUSH_CASES];
