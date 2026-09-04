/**
 * FIFO ring buffer for audit records. Keeps the most recent entries only.
 *
 * Memory-only by default; callers may opt-in to JSONL persistence.
 * Eviction is monotonic: oldest entry is dropped when full.
 */

export interface RingBufferOptions<T extends { id: number }> {
  /** Max entries before oldest is evicted. Default 50. */
  capacity?: number
  /** Called with each pushed record (after id assignment). */
  onPush?: (record: T) => void
}

export class AuditRingBuffer<T extends { id: number }> {
  private readonly entries: T[] = []
  private readonly capacity: number
  private readonly onPush: ((record: T) => void) | undefined

  constructor(opts: RingBufferOptions<T> = {}) {
    this.capacity = opts.capacity ?? 50
    this.onPush = opts.onPush
  }

  /**
   * Push a record. The record is inserted with its own id when one was
   * already assigned (the durable audit path allocates via {@link nextId}
   * and persists BEFORE pushing); otherwise the next monotonic id is
   * assigned here.
   */
  push(record: T): T {
    const id = (record as { id: number }).id
    if (typeof id !== 'number' || id === 0) {
      (record as { id: number }).id = this.nextId()
    }
    this.entries.push(record)
    while (this.entries.length > this.capacity) {
      this.entries.shift()
    }
    this.onPush?.(record)
    return record
  }

  /**
   * Assign the next monotonic id WITHOUT inserting into the live ring
   * buffer. The durable audit path calls this first, persists the record
   * under `String(id)`, then `push`es — push preserves the already-assigned
   * id so the live buffer and the durable trail stay aligned.
   */
  nextId(): number {
    return this.lastId + 1
  }

  /**
   * Rebuild the live ring buffer from durable history (host restart
   * replay). Clears the buffer and inserts every record in order WITHOUT
   * invoking onPush — rebuilds never re-broadcast history over WS. Ids
   * are preserved as given, so a domain-reloaded trail maps 1:1 to the
   * same ids it had before the restart.
   */
  rebuild(records: readonly T[]): void {
    this.entries.length = 0
    const sorted = [...records].sort((a, b) => a.id - b.id)
    for (const record of sorted) {
      this.entries.push(record)
    }
    while (this.entries.length > this.capacity) {
      this.entries.shift()
    }
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

  /** Largest id in the live ring buffer, or 0 if empty. */
  get lastId(): number {
    return this.entries.length === 0
      ? 0
      : (this.entries[this.entries.length - 1]!.id)
  }

  /** Drop everything. */
  clear(): void {
    this.entries.length = 0
  }
}
