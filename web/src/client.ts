import type {
  StreamEvent,
  WireThread,
} from "../../src/extensions/api/protocol.ts";

export interface StreamOptions {
  after: number;
  watch: readonly number[];
}

export class KaenoClient {
  readonly baseUrl: string;
  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }
  threads(): Promise<WireThread[]> {
    throw new Error("not implemented");
  }
  send(_thread: string, _text: string): Promise<void> {
    throw new Error("not implemented");
  }
  stop(_thread: string): Promise<void> {
    throw new Error("not implemented");
  }
  reset(_thread: string): Promise<void> {
    throw new Error("not implemented");
  }
  cancel(_thread: string, _workId: number): Promise<void> {
    throw new Error("not implemented");
  }
  stream(
    _thread: string,
    _options: StreamOptions,
    _onEvent: (event: StreamEvent) => void,
  ): () => void {
    throw new Error("not implemented");
  }
}
