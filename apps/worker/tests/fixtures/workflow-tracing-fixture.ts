import { continueAsNew, executeChild, proxyActivities, workflowInfo } from "@temporalio/workflow";

interface TraceActivities {
  traceFixtureActivity(input: { marker: string; traceparent?: string; prompt?: string }): Promise<string>;
}

const { traceFixtureActivity } = proxyActivities<TraceActivities>({
  startToCloseTimeout: "10 seconds"
});

/** Child workflow fixture that executes a single traced activity. */
export async function traceFixtureChild(input: { marker: string }) {
  return traceFixtureActivity({ marker: input.marker });
}

/** Root workflow fixture that runs an activity and spawns a child workflow. */
export async function traceFixtureRoot(input: { traceparent: string }) {
  const first = await traceFixtureActivity({ marker: "root", traceparent: input.traceparent, prompt: "SENSITIVE PROMPT" });
  const second = await executeChild(traceFixtureChild, {
    workflowId: workflowInfo().workflowId + ":child",
    args: [{ marker: "child" }]
  });
  return first + second;
}

/** Workflow fixture that exercises continue-as-new trace propagation. */
export async function traceFixtureContinue(input: { traceparent: string; remaining: number }) {
  await traceFixtureActivity({ marker: "continued" });
  if (input.remaining > 0) return continueAsNew<typeof traceFixtureContinue>({ ...input, remaining: input.remaining - 1 });
  return "final";
}

/** Workflow fixture that exercises background continuation trace linking. */
export async function traceFixtureBackground(input: {
  traceparent: string;
  roomAgentContinuation: { sourceRunId: string; generation: number; sourceTraceparent: string };
}) {
  await traceFixtureActivity({ marker: "background" });
  return "background";
}

/** Workflow fixture that exercises activity retry span parenting. */
export async function traceFixtureRetry(input: { traceparent: string }) {
  return traceFixtureActivity({ marker: "retry", traceparent: input.traceparent });
}
