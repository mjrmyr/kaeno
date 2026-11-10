import {
  forgetEntry,
  memoryIndex,
  updateEntry,
  type MemoryContent,
  type MemoryEntry,
} from "./memory.ts";
import type { MemoryStore } from "./store.ts";

/** Owner operations, independent of the transport used to request them. */
export class Memory {
  private readonly store: MemoryStore;

  constructor(store: MemoryStore) {
    this.store = store;
  }

  list(): ReturnType<typeof memoryIndex> {
    return memoryIndex(this.store.read());
  }

  get(id: string): (MemoryEntry & { id: string }) | undefined {
    const { entries } = this.store.read();
    const entry = entries[id];
    return Object.hasOwn(entries, id) && entry ? { id, ...entry } : undefined;
  }

  update(id: string, content: Omit<MemoryContent, "kind">): boolean {
    return this.store.mutate((state) =>
      updateEntry(state, id, content, Date.now()),
    );
  }

  remove(id: string): boolean {
    return this.store.mutate((state) => forgetEntry(state, id));
  }
}
