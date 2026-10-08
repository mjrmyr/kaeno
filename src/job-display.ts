import type { ContactState } from "./contact.ts";

export function visibleJobs(all: ContactState["jobs"], showHistory: boolean, selectedId?: number) {
  const recent = (showHistory ? all : all.filter(job => job.nativeStatus !== "terminal")).slice(-10);
  const selected = selectedId === undefined ? undefined : all.find(job => job.id === selectedId);
  return selected && !recent.includes(selected) ? [...recent, selected] : recent;
}
