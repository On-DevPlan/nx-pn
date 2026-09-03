/**
 * FIFO ring buffer for audit records. Spec §4.3 / §8.4: 1000-entry max.
 *
 * Memory-only by default; callers may opt-in to JSONL persistence.
 * Eviction is monotonic: oldest entry is dropped when full.
 */

export interface RingBufferOptions<T extends { id: number }> {
  /** Max entries before oldest is evicted. Default 1000. */
  capacity?: number
  /** Called with each pushed record (after id assignment). */
  onPush?: (record: T) => void
}

export class AuditRingBuffer<T extends { id: number }> {
  private readonly entries: T[] = []
  private readonly capacity: number
  private readonly onPush: ((record: T) => void) | undefined

  constructor(opts: RingBufferOptions<T> = {}) {
    this.capacity = opts.capacity ?? 1000
    this.onPush = opts.onPush
  }

  /** Push a record; assigns the next monotonic id (records always get a fresh id). */
  push(record: T): T {
    // Records carry an `id` slot that the caller leaves at 0 / undefined;
    // the ring assigns the monotonic id. We always override.
    (record as { id: number }).id = this.nextId()
    this.entries.push(record)
    while (this.entries.length > this.capacity) {
      this.entries.shift()
    }
    this.onPush?.(record)
    return record
  }

  /** Snapshot copy (oldest → newest). */
  snapshot(): T[] {
    return this.entries.slice()
  }

  /** Records strictly newer than `sinceId` (oldest → newest). */
  since(sinceId: number): T[] {
    return this.entries.filter((r) => r.id > sinceId)
  }

  /** Lookup by id; O(n) but n is bounded by capacity. */
  get(id: number): T | undefined {
    return this.entries.find((r) => r.id === id)
  }

  /** Current size (≤ capacity). */
  get size(): number {
    return this.entries.length
  }

  /** Largest assigned id, or 0 if empty. */
  get lastId(): number {
    return this.entries.length === 0
      ? 0
      : (this.entries[this.entries.length - 1]!.id)
  }

  /** Drop everything. */
  clear(): void {
    this.entries.length = 0
  }

  private nextId(): number {
    return this.lastId + 1
  }
}