/** The one list of WORK protocol names. Work registers its tools from these; hosts approve from them. */
export const START_WORK = "start_work";
export const LIST_WORK = "list_work";
export const INSPECT_WORK = "inspect_work";
export const MESSAGE_WORK = "message_work";
export const CANCEL_WORK = "cancel_work";
export const MESSAGE_PARENT = "message_parent";
/** A ticket root's report to the router: progress, a question, an obstacle, or nothing to do. */
export const REPORT = "report";
export const WORK_EXTENSION = "kaeno-work";

export const WORK_TOOLS = {
  /** Order is registration order and appears in stored setups; do not reorder. */
  orchestration: [
    START_WORK,
    LIST_WORK,
    INSPECT_WORK,
    MESSAGE_WORK,
    CANCEL_WORK,
  ],
  parent: [MESSAGE_PARENT, REPORT],
  readOnly: [LIST_WORK, INSPECT_WORK],
} as const;
