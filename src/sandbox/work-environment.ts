import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  defineDoc,
  type Cursor,
  type EnvTarget,
  type JsonObject,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { randomBytes } from "node:crypto";
import type {
  WorkEnvironment,
  WorkEnvironmentRuntime,
  WorkInstance,
} from "../work/index.ts";
import type {
  SandboxIdentity,
  SandboxLimits,
  SandboxProvider,
} from "./provider.ts";

interface SandboxIdentityData extends JsonObject {
  id: string;
  token: string;
  image: string;
}
interface SandboxState extends JsonObject {
  identity: SandboxIdentityData | null;
}
const WorkSandbox = defineDoc<SandboxState>({
  kind: "kaeno.work-sandbox",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ identity: null }),
});

/** Optional sandbox adapter. Participant discovery/configuration never depends on this class. */
export class SandboxWorkEnvironment implements WorkEnvironment {
  readonly cwd = "/workspace";
  private readonly options: {
    sandbox: SandboxProvider;
    image: string;
    limits: SandboxLimits;
  };
  constructor(options: {
    sandbox: SandboxProvider;
    image: string;
    limits: SandboxLimits;
  }) {
    this.options = options;
  }

  async ensure(
    work: WorkInstance,
    runtime: WorkEnvironmentRuntime,
    context: Context,
  ): Promise<void> {
    const identity = await runtime.commit(async (tx) => {
      const state = await tx.doc(WorkSandbox, work.conversationId);
      state.identity ??= {
        id: `work-${work.workId}`,
        token: randomBytes(32).toString("hex"),
        image: this.options.image,
      };
      return { ...state.identity };
    }, context);
    await this.options.sandbox.ensure(
      identity,
      {
        cwd: this.cwd,
        limits: this.options.limits,
      },
      context.abortSignal,
    );
  }

  async release(
    work: WorkInstance,
    runtime: WorkEnvironmentRuntime,
  ): Promise<void> {
    const state = await runtime.snapshot(
      WorkSandbox,
      work.conversationId,
      BACKGROUND_CONTEXT,
    );
    if (state?.identity) {
      await this.options.sandbox.remove(state.identity);
    }
  }

  async reconcile(
    live: readonly WorkInstance[],
    runtime: WorkEnvironmentRuntime,
  ): Promise<void> {
    const identities: SandboxIdentity[] = [];
    for (const work of live) {
      const state = await runtime.snapshot(
        WorkSandbox,
        work.conversationId,
        BACKGROUND_CONTEXT,
      );
      if (state?.identity) {
        identities.push(state.identity);
      }
    }
    if (identities.length === 0) {
      // A fresh standalone installation must not need Docker merely to boot. Only contact the
      // backend if this database has actually owned an environment (including terminal orphans).
      let cursor: Cursor | undefined;
      let owned = false;
      do {
        const page = await runtime.commit(
          (tx) => tx.scanConversations({}, 100, cursor),
          BACKGROUND_CONTEXT,
        );
        for (const conversation of page.items) {
          if (
            (
              await runtime.snapshot(
                WorkSandbox,
                conversation.id,
                BACKGROUND_CONTEXT,
              )
            )?.identity
          ) {
            owned = true;
            break;
          }
        }
        cursor = page.next;
      } while (!owned && cursor !== undefined);
      if (!owned) {
        return;
      }
    }
    await this.options.sandbox.reconcile(identities);
  }

  async executionEnvironment(
    target: EnvTarget,
    context: Context,
  ): Promise<ExecutionEnv | undefined> {
    const state = await target.read.snapshot(
      WorkSandbox,
      target.conversationId,
      context,
    );
    if (!state?.identity) {
      return undefined;
    }
    return this.options.sandbox.executionEnvironment(
      state.identity,
      target.cwd ?? this.cwd,
    );
  }
}
