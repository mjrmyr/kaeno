import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
  ConversationId,
  Harness,
  TaskId,
  Tx,
} from "@earendil-works/pi-durable";
import {
  activeTurn,
  admitCancel,
  admitActivityCancellation,
  isResultSource,
  resultActivityId,
  admitControl,
  admitTurn,
  suppressReports,
  TurnLedger,
  type ControlTask,
  type Notify,
  type Origin,
  type Reply,
  type Source,
  type TurnTask,
  type ValidateActivityCancellation,
} from "./turns.ts";
export interface ReplyPage {
  replies: Reply[];
  next: number;
  truncated: boolean;
}
export interface ActivityResult {
  activityId: TaskId;
  /** Globally unique within the activity-result request namespace. */
  key: string;
  content: string;
  report: string;
  origin: Origin;
  label?: string;
}
export class TurnCoordinator {
  readonly turnTask: TurnTask;
  readonly controlTask: ControlTask;
  private readonly harness: () => Harness;
  private readonly validateWorkCancellation?: ValidateActivityCancellation;
  constructor(
    harness: () => Harness,
    turnTask: TurnTask,
    controlTask: ControlTask,
    validateWorkCancellation?: ValidateActivityCancellation,
  ) {
    this.harness = harness;
    this.validateWorkCancellation = validateWorkCancellation;
    this.turnTask = turnTask;
    this.controlTask = controlTask;
  }
  admitUserTurn(
    tx: Tx,
    id: ConversationId,
    content: string,
    requestId: string,
    notify?: Notify,
  ): Promise<TaskId> {
    return admitTurn(tx, this.turnTask, {
      conversationId: id,
      content,
      requestId,
      notify,
    });
  }
  admitStop(tx: Tx, id: ConversationId): Promise<TaskId> {
    return admitControl(tx, this.controlTask, id, "stop");
  }
  admitReset(tx: Tx, id: ConversationId): Promise<TaskId> {
    return admitControl(tx, this.controlTask, id, "reset");
  }
  admitWorkCancellation(
    tx: Tx,
    id: ConversationId,
    workId: TaskId,
  ): Promise<TaskId> {
    return admitCancel(
      tx,
      this.controlTask,
      id,
      workId,
      this.validateWorkCancellation,
    );
  }
  admitActivityCancellation(
    tx: Tx,
    id: ConversationId,
    activityId: TaskId,
    validate: ValidateActivityCancellation,
  ): Promise<TaskId> {
    return admitActivityCancellation(
      tx,
      this.controlTask,
      id,
      activityId,
      validate,
    );
  }
  async readReplies(id: ConversationId, after: number): Promise<ReplyPage> {
    const ledger = await this.harness().snapshot(
      TurnLedger,
      id,
      BACKGROUND_CONTEXT,
    );
    const replies = ledger?.replies ?? [];
    const [first] = replies;
    return {
      replies: replies.filter((reply) => reply.id > after),
      next: (ledger?.next ?? 1) - 1,
      truncated: first !== undefined && after < first.id - 1,
    };
  }
  async readReplyText(
    id: ConversationId,
    requestId: string,
  ): Promise<string | undefined> {
    return (await this.harness().snapshot(TurnLedger, id, BACKGROUND_CONTEXT))
      ?.receipts[requestId]?.text;
  }
  getActiveTurn(
    id: ConversationId,
    ctx: Context,
  ): Promise<{
    origin: Origin;
    source: Source;
  }> {
    return activeTurn(this.harness(), id, ctx);
  }
  async isOriginFenced(tx: Tx, origin: Origin): Promise<boolean> {
    const ledger = await tx.doc(TurnLedger, origin.conversationId);
    return Boolean(ledger.control) || ledger.epoch !== origin.epoch;
  }
  async getPendingReportIds(tx: Tx, id: ConversationId): Promise<TaskId[]> {
    const ledger = await tx.doc(TurnLedger, id);
    return Object.values(ledger.receipts).flatMap((receipt) =>
      receipt.source.kind === "work-result" &&
      ["pending", "dispatching"].includes(receipt.delivery)
        ? [receipt.source.workId]
        : [],
    );
  }
  async getPendingActivityIds(tx: Tx, id: ConversationId): Promise<TaskId[]> {
    const ledger = await tx.doc(TurnLedger, id);
    return Object.values(ledger.receipts).flatMap((receipt) =>
      isResultSource(receipt.source) &&
      ["pending", "dispatching"].includes(receipt.delivery)
        ? [resultActivityId(receipt.source)]
        : [],
    );
  }
  suppressActivityResults(
    tx: Tx,
    id: ConversationId,
    ids: readonly TaskId[],
  ): Promise<void> {
    return suppressReports(tx, id, ids);
  }
  /** Result inputs are trusted feature callbacks, never user-admitted mutation authority. */
  admitActivityResult(tx: Tx, result: ActivityResult): Promise<TaskId> {
    const { activityId, origin } = result;
    return admitTurn(tx, this.turnTask, {
      conversationId: origin.conversationId,
      requestId: `activity-result:${result.key}`,
      notify: origin.notify,
      source: {
        kind: "activity-result",
        activityId,
        requestId: origin.requestId,
        epoch: origin.epoch,
        ...(result.label === undefined ? {} : { label: result.label }),
      },
      content: result.content,
      report: result.report,
    });
  }
  suppressWorkReports(
    tx: Tx,
    id: ConversationId,
    ids: readonly TaskId[],
  ): Promise<void> {
    return suppressReports(tx, id, ids);
  }
  /** A WORK message or final report, delivered to its CHAT as a read-only work-result turn. */
  admitWorkReport(
    tx: Tx,
    report: {
      workId: TaskId;
      key: string;
      content: string;
      report: string;
      origin: Origin;
    },
  ): Promise<TaskId> {
    const { workId, origin } = report;
    return admitTurn(tx, this.turnTask, {
      conversationId: origin.conversationId,
      requestId: `work-report:${report.key}`,
      notify: origin.notify,
      source: {
        kind: "work-result",
        workId,
        requestId: origin.requestId,
        epoch: origin.epoch,
      },
      report: report.report,
      content: report.content,
    });
  }
}
