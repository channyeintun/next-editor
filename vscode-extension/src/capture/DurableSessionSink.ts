import type { CheckpointMeta, SessionEvent } from "../model/events";
import type { CheckpointStore } from "../storage/CheckpointStore";
import type { OrderedJournalWriter } from "../storage/OrderedJournalWriter";
import type { EventSink } from "./EventSink";

// EventSink over the durable journal. Checkpoint bodies ride the same
// ordered pipeline as barriers, so a journaled checkpoint reference is
// never durable before its body (plan §9.4).
export class DurableSessionSink implements EventSink {
  constructor(
    private readonly journal: OrderedJournalWriter,
    private readonly checkpoints: CheckpointStore,
  ) {}

  append(event: SessionEvent): void {
    this.journal.enqueue(event);
  }

  storeCheckpoint(meta: CheckpointMeta, text: string): void {
    this.journal.enqueueBarrier(() => this.checkpoints.write(meta, text));
  }
}
