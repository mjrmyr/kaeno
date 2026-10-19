import type { ConversationId, TaskId, Tx } from "@earendil-works/pi-durable";
import type { TurnCoordinator } from "../turns/index.ts";
import type { WorkReport, WorkTurns } from "./model.ts";

/** Adapt work reports to Kaeno's generic causal activity-result protocol. */
export function workTurns(turns: () => TurnCoordinator): WorkTurns {
  return {
    getActiveTurn: (id, context) => turns().getActiveTurn(id, context),
    isOriginFenced: (tx, origin) => turns().isOriginFenced(tx, origin),
    getPendingReportIds: (tx, id) => turns().getPendingActivityIds(tx, id),
    suppressWorkReports: (tx, id, ids) =>
      turns().suppressActivityResults(tx, id, ids),
    admitWorkReport(tx, report: WorkReport) {
      return turns().admitActivityResult(tx, {
        activityId: report.workId,
        key: report.key,
        content: report.content,
        report: report.report,
        origin: report.origin,
        label: `Work #${report.workId}`,
      });
    },
    admitWorkCancellation(tx: Tx, id: ConversationId, workId: TaskId) {
      return turns().admitActivityCancellation(
        tx,
        id,
        workId,
        async (transaction, owner, activity) => {
          const work = await transaction.task(activity);
          if (
            !work ||
            work.kind !== "kaeno.work" ||
            work.conversationId !== owner
          ) {
            throw new Error(`Work #${activity} was not started here`);
          }
        },
      );
    },
  };
}
