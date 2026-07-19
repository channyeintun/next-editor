import type { SessionEvent } from "../model/events";
import type { CheckpointMeta } from "../model/events";
import { LIMITS } from "../model/limits";

// Ordered event consumer. Phase 2 uses the in-memory sink; Phase 4 adds the
// durable journal sink. Checkpoint text travels beside the event stream so
// events themselves stay small.
export interface EventSink {
  append(event: SessionEvent): void;
  storeCheckpoint(meta: CheckpointMeta, text: string): void;
}

export class InMemoryEventSink implements EventSink {
  readonly events: SessionEvent[] = [];
  readonly checkpoints = new Map<string, { meta: CheckpointMeta; text: string }>();
  overloaded = false;

  append(event: SessionEvent): void {
    if (this.events.length >= LIMITS.maxEventsPerSession) {
      this.overloaded = true;
      return;
    }
    this.events.push(event);
  }

  storeCheckpoint(meta: CheckpointMeta, text: string): void {
    this.checkpoints.set(meta.checkpointId, { meta, text });
  }
}
