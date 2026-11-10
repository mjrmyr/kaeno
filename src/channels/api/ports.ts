/** Capabilities supplied by the host. No transport or persistence types cross this boundary. */
export interface MemoryAccess {
  list(): {
    preferences: { id: string; text: string; savedAt: number }[];
    memories: { id: string; title: string; savedAt: number }[];
  };
  get(id: string):
    | { id: string; kind: "preference"; text: string; savedAt: number }
    | {
        id: string;
        kind: "memory";
        title: string;
        text: string;
        savedAt: number;
      }
    | undefined;
  update(id: string, content: { title?: string; text: string }): boolean;
  remove(id: string): boolean;
}

export interface RoutineFields {
  name: string;
  agent: string;
  instructions: string;
  schedule:
    { every: number } | { at: string; timeZone: string; days?: number[] };
  thread: string;
  timeoutMinutes: number;
  enabled: boolean;
}

export interface Routine extends RoutineFields {
  id: number;
  updatedAt: number;
}

export interface RoutineView extends Routine {
  lastRun?: {
    ticket: string;
    startedAt: number;
    status: string;
    report?: string;
  };
  nextRun?: number;
}

export type RoutineChange = (
  | { action: "create"; input: RoutineFields }
  | {
      action: "update";
      routineId: number;
      baseUpdatedAt: number;
      input: RoutineFields;
    }
  | { action: "delete"; routineId: number; baseUpdatedAt: number }
) & {
  id: string;
  status: "pending" | "approved" | "rejected";
  createdAt: number;
  decidedAt?: number;
  result?: number;
};

export interface RoutineAccess {
  describe(now: number): Promise<RoutineView[]>;
  /** The capability validates feature-specific input, including agent resolution. */
  create(input: unknown): Routine;
  replace(id: number, input: unknown): boolean;
  remove(id: number): boolean;
  changes(): RoutineChange[];
  approve(id: string): RoutineChange;
  reject(id: string): RoutineChange;
  runNow(id: number): Promise<string>;
}
