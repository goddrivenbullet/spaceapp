import { sleep } from "@temporalio/workflow";
import { dummyTurnWorkflow as original } from "../../src/workflows.js";

// Deliberately incompatible, test-only mutation. Never registered in the app.
/** Deliberately incompatible test workflow that inserts an extra timer before delegating. */
export async function dummyTurnWorkflow(input: Parameters<typeof original>[0]) {
  await sleep("1 second");
  return original(input);
}
