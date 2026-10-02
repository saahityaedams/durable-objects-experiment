import { DurableObject } from "cloudflare:workers";

/**
 * One UserHold DO per (event, user). SeatShards are sharded by section and
 * don't know about each other, so a venue-wide invariant like "at most N
 * active holds per person" needs a separate coordination point. This DO is
 * that point: every hold attempt reserves a slot here first.
 */
export class UserHold extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS holds (
          hold_id TEXT PRIMARY KEY,
          seat_id TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        )
      `);
    });
  }

  private pruneExpired(): void {
    this.ctx.storage.sql.exec("DELETE FROM holds WHERE expires_at <= ?", Date.now());
  }

  async tryReserve(
    holdId: string,
    seatId: string,
    expiresAt: number,
    maxHolds: number,
  ): Promise<{ ok: boolean; holdId: string; activeHolds: number }> {
    this.pruneExpired();
    const [{ count }] = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) as count FROM holds")
      .toArray();

    // A seat this user already holds reuses its slot rather than taking a
    // second one (or being refused when they're at the limit).
    const [existing] = this.ctx.storage.sql
      .exec<{ hold_id: string }>("SELECT hold_id FROM holds WHERE seat_id = ?", seatId)
      .toArray();
    if (existing) return { ok: true, holdId: existing.hold_id, activeHolds: count };

    if (count >= maxHolds) return { ok: false, holdId, activeHolds: count };

    this.ctx.storage.sql.exec(
      "INSERT INTO holds (hold_id, seat_id, expires_at) VALUES (?, ?, ?)",
      holdId,
      seatId,
      expiresAt,
    );
    return { ok: true, holdId, activeHolds: count + 1 };
  }

  async release(holdId: string): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM holds WHERE hold_id = ?", holdId);
  }

  async activeHolds(): Promise<number> {
    this.pruneExpired();
    const [{ count }] = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) as count FROM holds")
      .toArray();
    return count;
  }
}
