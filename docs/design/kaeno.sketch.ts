// HISTORICAL PRE-IMPLEMENTATION SKETCH; see src/contact.ts and src/jobs.ts for running code.
// Some signatures here were superseded during implementation. Do not import or run this file.
import { type Context } from "@earendil-works/chord";
import {
  defineDoc, defineTask, type ConversationId, type TaskId, type Tx, type JsonObject,
} from "@earendil-works/pi-durable";

export type JobId = string & { readonly __jobId: unique symbol };
export type ModelChoice = { readonly provider: string; readonly modelId: string };
export type ContactMessage = { readonly role: "user" | "assistant"; readonly text: string };
export type JobResult =
  | { readonly type: "completed"; readonly summary: string }
  | { readonly type: "failed" | "outcome_unknown"; readonly reason: string }
  | { readonly type: "cancelled" };
export type JobView = {
  readonly id: JobId;
  readonly agent: string;
  readonly objective: string;
  readonly result?: JobResult;
  readonly notice?: "pending" | "attempted" | "deferred";
};
export type KaenoSnapshot = {
  readonly contact: { readonly messages: readonly ContactMessage[] };
  readonly jobs: readonly JobView[];
};
export type SendReceipt = { readonly requestId: string; readonly submissionId: string };
export type ContactSpec = { readonly model: ModelChoice; readonly instructions: string };
export type Limits = { readonly activeJobs: number; readonly activePerAgent: number; readonly retainedJobs: number };
export type OpenOptions = {
  readonly stateFile: string;
  readonly agentsDir: string;
  readonly contact: ContactSpec;
  readonly limits: Limits;
};
export interface Kaeno {
  send(input: { readonly requestId: string; readonly text: string }): Promise<SendReceipt>;
  snapshot(): Promise<KaenoSnapshot>;
  cancelContact(): Promise<void>;
  cancelJob(id: JobId): Promise<void>;
  close(): Promise<void>;
}
export async function openKaeno(_options: OpenOptions): Promise<Kaeno> {
  // TODO: consolidate Harness/store ownership here, not in an extra task scheduler.
  throw new Error("not implemented: job-capable Kaeno facade");
}

// Private jobs module sketch. Native types do not leak through the public API.
type Profile = JsonObject & {
  readonly name: string;
  readonly model: ModelChoice;
  readonly instructions: string;
  readonly workspace: string;
  readonly tools: readonly ("read")[];
  readonly profileRevision: string;
  readonly runtimeRevision: string;
};
type JobRecord = JsonObject & {
  taskId: string;
  childId: string;
  agent: string;
  objective: string;
  profile: Profile;
  result?: JsonObject; // serialized result; validated as JobResult at the facade boundary.
  notice?: "pending" | "attempted" | "deferred";
};
type JobsState = JsonObject & {
  byOrigin: Record<string, JsonObject & { digest: string; jobId: string }>;
  jobs: Record<string, JobRecord>;
};
const JobsDoc = defineDoc<JobsState>({
  kind: "kaeno.jobs", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ byOrigin: {}, jobs: {} }),
});
type JobInput = {
  readonly agent: string;
  readonly objective: string;
  readonly brief: string;
  readonly profile: Profile;
  readonly contactRevision: string;
};
type JobCheckpoint = { phase: "start" } | { phase: "await_child" } | { phase: "report" };
const Job = defineTask<JobInput, JobCheckpoint, JobId>({
  name: "kaeno.job", version: 1, initial: () => ({ phase: "start" }),
  phases: {
    start: async (_task, _runtime, _context) => {
      // TODO: stable child submission `kaeno:work:<taskId>`; checkpoint await_child.
      throw new Error("not implemented");
    },
    await_child: async (_task, _runtime, _context) => {
      // TODO: wait for answer; commit result card + pending notice with report checkpoint.
      throw new Error("not implemented");
    },
    report: async (_task, _runtime, _context) => {
      // TODO: exactly ONE logical follow-up `kaeno:report:<taskId>`;
      // retry the same ID; never treat admission as a human receipt.
      throw new Error("not implemented");
    },
  },
  abort: async (_task, _runtime, _context) => {
    // TODO: preserve any saved result, else record cancellation or unknown outcome.
    throw new Error("not implemented");
  },
});
async function countActiveBeforeWrites(_tx: Tx, _state: JobsState, _agent: string): Promise<number> {
  // TODO: count every nonterminal native Job, including `completing`.
  throw new Error("not implemented");
}
async function admitDelegate(_originTaskId: TaskId, _agent: string, _objective: string,
  _brief: string, _context: Context): Promise<JobId> {
  // TODO: creation-only commit: lookup origin + read all native capacity BEFORE writes;
  // immutable profile and contact revision; create background Job + child together.
  throw new Error("not implemented");
}
void [JobsDoc, Job, countActiveBeforeWrites, admitDelegate];
