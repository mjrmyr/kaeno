import type { AgentEvent } from "@earendil-works/pi-durable";

export interface WireThread {
  key: string;
  createdAt: number;
}

export interface WireReply {
  id: number;
  requestId: string;
  text: string;
}

export interface WorkNode {
  id: number;
  title: string;
  agent: string;
  status: string;
  conversation?: number;
  children: WorkNode[];
}

export type StreamEvent =
  | { type: "thread"; conversation: number }
  | { type: "replies"; replies: WireReply[]; next: number; truncated: boolean }
  | { type: "work"; tree: WorkNode[] }
  | { type: "agent"; conversation: number; event: AgentEvent };
