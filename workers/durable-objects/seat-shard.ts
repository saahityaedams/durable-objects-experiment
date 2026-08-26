import { DurableObject } from "cloudflare:workers";

export type SeatStatus = "available" | "held" | "booked";

export interface SeatRow {
  [column: string]: SqlStorageValue;
  seat_id: string;
  event_id: string;
  section: string;
  row: number;
  number: number;
  price: number;
  status: SeatStatus;
  hold_id: string | null;
  held_by: string | null;
  hold_expires_at: number | null;
  booked_by: string | null;
}

export interface SeatView {
  seat_id: string;
  section: string;
  row: number;
  number: number;
  price: number;
  status: SeatStatus;
  held_by: string | null;
  hold_expires_at: number | null;
  booked_by: string | null;
  isMine?: boolean;
}

interface HoldResult {
  ok: boolean;
  reason?: "not_found" | "unavailable" | "already_booked";
  expiresAt?: number;
}

/**
 * One SeatShard per (event, section). Keeping shards small bounds the
 * single-threaded serialization cost of each hold/confirm call to a
 * few hundred seats instead of an entire venue.
 */
export class SeatShard extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS seats (
          seat_id TEXT PRIMARY KEY,
          event_id TEXT NOT NULL,
          section TEXT NOT NULL,
          row INTEGER NOT NULL,
          number INTEGER NOT NULL,
          price INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'available',
          hold_id TEXT,
          held_by TEXT,
          hold_expires_at INTEGER,
          booked_by TEXT
        )
      `);
    });
  }

  /** Idempotent: seeds the shard's inventory only if it is currently empty. */
  async seed(
    eventId: string,
    section: string,
    rows: number,
    seatsPerRow: number,
    price: number,
  ): Promise<void> {
    const [{ count }] = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) as count FROM seats")
      .toArray();
    if (count > 0) return;

    for (let row = 1; row <= rows; row++) {
      for (let number = 1; number <= seatsPerRow; number++) {
        const seatId = `${section}-${row}-${number}`;
        this.ctx.storage.sql.exec(
          `INSERT INTO seats (seat_id, event_id, section, row, number, price, status)
           VALUES (?, ?, ?, ?, ?, ?, 'available')`,
          seatId,
          eventId,
          section,
          row,
          number,
          price,
        );
      }
    }
  }

  async listSeats(viewerId?: string): Promise<SeatView[]> {
    const now = Date.now();
    const rows = this.ctx.storage.sql
      .exec<SeatRow>("SELECT * FROM seats ORDER BY row, number")
      .toArray();

    return rows.map((r): SeatView => {
      const expired = r.status === "held" && r.hold_expires_at !== null && r.hold_expires_at <= now;
      const status: SeatStatus = expired ? "available" : r.status;
      return {
        seat_id: r.seat_id,
        section: r.section,
        row: r.row,
        number: r.number,
        price: r.price,
        status,
        held_by: expired ? null : r.held_by,
        hold_expires_at: expired ? null : r.hold_expires_at,
        booked_by: r.booked_by,
        isMine: !expired && r.held_by === viewerId,
      };
    });
  }

  async holdSeat(
    seatId: string,
    userId: string,
    holdId: string,
    holdMs: number,
  ): Promise<HoldResult> {
    const now = Date.now();
    const [seat] = this.ctx.storage.sql
      .exec<SeatRow>("SELECT * FROM seats WHERE seat_id = ?", seatId)
      .toArray();
    if (!seat) return { ok: false, reason: "not_found" };

    if (seat.status === "booked") return { ok: false, reason: "already_booked" };

    const currentlyHeld =
      seat.status === "held" && seat.hold_expires_at !== null && seat.hold_expires_at > now;
    if (currentlyHeld) return { ok: false, reason: "unavailable" };

    const expiresAt = now + holdMs;
    this.ctx.storage.sql.exec(
      `UPDATE seats SET status = 'held', hold_id = ?, held_by = ?, hold_expires_at = ?
       WHERE seat_id = ?`,
      holdId,
      userId,
      expiresAt,
      seatId,
    );

    await this.rescheduleAlarm();
    return { ok: true, expiresAt };
  }

  async confirmBooking(seatId: string, holdId: string, userId: string): Promise<HoldResult> {
    const now = Date.now();
    const [seat] = this.ctx.storage.sql
      .exec<SeatRow>("SELECT * FROM seats WHERE seat_id = ?", seatId)
      .toArray();
    if (!seat) return { ok: false, reason: "not_found" };

    const validHold =
      seat.status === "held" &&
      seat.hold_id === holdId &&
      seat.held_by === userId &&
      seat.hold_expires_at !== null &&
      seat.hold_expires_at > now;
    if (!validHold) return { ok: false, reason: "unavailable" };

    this.ctx.storage.sql.exec(
      `UPDATE seats SET status = 'booked', booked_by = ?, hold_id = NULL, held_by = NULL, hold_expires_at = NULL
       WHERE seat_id = ?`,
      userId,
      seatId,
    );

    await this.rescheduleAlarm();
    return { ok: true };
  }

  async releaseHold(seatId: string, holdId: string): Promise<{ ok: boolean }> {
    const [seat] = this.ctx.storage.sql
      .exec<SeatRow>("SELECT * FROM seats WHERE seat_id = ?", seatId)
      .toArray();
    if (!seat || seat.status !== "held" || seat.hold_id !== holdId) return { ok: false };

    this.ctx.storage.sql.exec(
      `UPDATE seats SET status = 'available', hold_id = NULL, held_by = NULL, hold_expires_at = NULL
       WHERE seat_id = ?`,
      seatId,
    );
    await this.rescheduleAlarm();
    return { ok: true };
  }

  private async rescheduleAlarm(): Promise<void> {
    const [next] = this.ctx.storage.sql
      .exec<{ min_expiry: number | null }>(
        "SELECT MIN(hold_expires_at) as min_expiry FROM seats WHERE status = 'held'",
      )
      .toArray();
    if (next?.min_expiry) {
      await this.ctx.storage.setAlarm(next.min_expiry);
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }

  /** Sweeps expired holds back to available and frees the matching per-user hold slot. */
  async alarm(): Promise<void> {
    const now = Date.now();
    const expired = this.ctx.storage.sql
      .exec<SeatRow>(
        "SELECT * FROM seats WHERE status = 'held' AND hold_expires_at IS NOT NULL AND hold_expires_at <= ?",
        now,
      )
      .toArray();

    for (const seat of expired) {
      this.ctx.storage.sql.exec(
        `UPDATE seats SET status = 'available', hold_id = NULL, held_by = NULL, hold_expires_at = NULL
         WHERE seat_id = ?`,
        seat.seat_id,
      );
    }

    await this.rescheduleAlarm();

    for (const seat of expired) {
      if (!seat.held_by || !seat.hold_id) continue;
      const userHoldStub = this.env.USER_HOLD.getByName(`${seat.event_id}:user:${seat.held_by}`);
      await userHoldStub.release(seat.hold_id);
    }
  }
}
