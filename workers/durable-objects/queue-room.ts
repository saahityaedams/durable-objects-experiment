import { DurableObject } from "cloudflare:workers";
import { mintAdmissionToken } from "../lib/admission-token";
import {
  ADMISSION_TOKEN_TTL_MS,
  QUEUE_BATCH_SIZE,
  QUEUE_TICK_MS,
  QUEUE_WARMUP_MS,
} from "../lib/config";

interface QueueEntryRow {
  [column: string]: SqlStorageValue;
  user_id: string;
  joined_at: number;
  lottery_number: number | null;
  status: "waiting" | "admitted";
  admitted_at: number | null;
  admission_token: string | null;
}

export interface QueueStatus {
  status: "waiting" | "admitted";
  saleOpensAt: number;
  waitingAhead: number | null;
  waitingTotal: number;
  admissionToken: string | null;
  admissionExpiresAt: number | null;
}

/**
 * One QueueRoom per event: the virtual waiting room. Everyone who arrives
 * before doors-open is shuffled into a random lottery order at open time, so
 * script/bot speed advantages before the sale starts don't matter. Anyone who
 * joins after open is stacked strictly behind that cohort. A ticking alarm
 * admits people in small batches so downstream SeatShards / payment never
 * see the full crowd at once.
 */
export class QueueRoom extends DurableObject<Env> {
  private eventId: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS entries (
          user_id TEXT PRIMARY KEY,
          joined_at INTEGER NOT NULL,
          lottery_number REAL,
          status TEXT NOT NULL DEFAULT 'waiting',
          admitted_at INTEGER,
          admission_token TEXT
        )
      `);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const eventId = url.searchParams.get("eventId");
    const userId = url.searchParams.get("userId");
    if (!eventId || !userId) {
      return new Response("eventId and userId are required", { status: 400 });
    }
    this.eventId = eventId;
    await this.ctx.storage.put("eventId", eventId);
    await this.ensureSaleOpensAt();

    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server, [userId]);
      await this.ensureEntry(userId);
      server.send(JSON.stringify(await this.buildStatus(userId)));
      await this.ensureTicking();
      return new Response(null, { status: 101, webSocket: client });
    }

    await this.ensureEntry(userId);
    await this.ensureTicking();
    return Response.json(await this.buildStatus(userId));
  }

  webSocketMessage(): void {
    // Clients don't need to send anything; state changes are server-driven.
  }

  webSocketClose(ws: WebSocket): void {
    ws.close();
  }

  private async ensureSaleOpensAt(): Promise<number> {
    let saleOpensAt = await this.ctx.storage.get<number>("saleOpensAt");
    if (!saleOpensAt) {
      saleOpensAt = Date.now() + QUEUE_WARMUP_MS;
      await this.ctx.storage.put("saleOpensAt", saleOpensAt);
    }
    return saleOpensAt;
  }

  private async ensureEntry(userId: string): Promise<void> {
    const [existing] = this.ctx.storage.sql
      .exec<QueueEntryRow>("SELECT * FROM entries WHERE user_id = ?", userId)
      .toArray();
    if (existing) return;

    const saleOpensAt = await this.ensureSaleOpensAt();
    const now = Date.now();
    // Latecomers get a lottery number already, but shifted above 1 so they
    // always sort after the pre-open cohort (assigned in the range [0, 1)).
    const lotteryNumber = now >= saleOpensAt ? 1 + Math.random() : null;

    this.ctx.storage.sql.exec(
      "INSERT INTO entries (user_id, joined_at, lottery_number, status) VALUES (?, ?, ?, 'waiting')",
      userId,
      now,
      lotteryNumber,
    );
  }

  private async ensureTicking(): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null) {
      await this.ctx.storage.setAlarm(Date.now() + QUEUE_TICK_MS);
    }
  }

  private async buildStatus(userId: string): Promise<QueueStatus> {
    const saleOpensAt = await this.ensureSaleOpensAt();
    const [me] = this.ctx.storage.sql
      .exec<QueueEntryRow>("SELECT * FROM entries WHERE user_id = ?", userId)
      .toArray();

    const [{ count: waitingTotal }] = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) as count FROM entries WHERE status = 'waiting'")
      .toArray();

    if (!me || me.status === "waiting") {
      let waitingAhead: number | null = null;
      if (me?.lottery_number !== null && me?.lottery_number !== undefined) {
        const [{ count }] = this.ctx.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) as count FROM entries WHERE status = 'waiting' AND lottery_number < ?",
            me.lottery_number,
          )
          .toArray();
        waitingAhead = count;
      }
      return {
        status: "waiting",
        saleOpensAt,
        waitingAhead,
        waitingTotal,
        admissionToken: null,
        admissionExpiresAt: null,
      };
    }

    return {
      status: "admitted",
      saleOpensAt,
      waitingAhead: 0,
      waitingTotal,
      admissionToken: me.admission_token,
      admissionExpiresAt: me.admitted_at ? me.admitted_at + ADMISSION_TOKEN_TTL_MS : null,
    };
  }

  /** Assigns lottery numbers to the pre-open cohort exactly once, at open. */
  private async assignLotteryIfOpen(saleOpensAt: number): Promise<void> {
    if (Date.now() < saleOpensAt) return;
    const unassigned = this.ctx.storage.sql
      .exec<QueueEntryRow>("SELECT * FROM entries WHERE lottery_number IS NULL")
      .toArray();
    for (const entry of unassigned) {
      this.ctx.storage.sql.exec(
        "UPDATE entries SET lottery_number = ? WHERE user_id = ?",
        Math.random(),
        entry.user_id,
      );
    }
  }

  async alarm(): Promise<void> {
    const saleOpensAt = await this.ensureSaleOpensAt();
    await this.assignLotteryIfOpen(saleOpensAt);

    if (Date.now() >= saleOpensAt) {
      const eventId = this.eventId ?? (await this.ctx.storage.get<string>("eventId"));
      const batch = this.ctx.storage.sql
        .exec<QueueEntryRow>(
          `SELECT * FROM entries
           WHERE status = 'waiting' AND lottery_number IS NOT NULL
           ORDER BY lottery_number ASC
           LIMIT ?`,
          QUEUE_BATCH_SIZE,
        )
        .toArray();

      for (const entry of batch) {
        const now = Date.now();
        const token = eventId
          ? await mintAdmissionToken(
              { eventId, userId: entry.user_id, exp: now + ADMISSION_TOKEN_TTL_MS },
              this.env.ADMISSION_TOKEN_SECRET,
            )
          : null;

        this.ctx.storage.sql.exec(
          "UPDATE entries SET status = 'admitted', admitted_at = ?, admission_token = ? WHERE user_id = ?",
          now,
          token,
          entry.user_id,
        );

        for (const ws of this.ctx.getWebSockets(entry.user_id)) {
          ws.send(JSON.stringify(await this.buildStatus(entry.user_id)));
        }
      }
    }

    const [{ count: stillWaiting }] = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) as count FROM entries WHERE status = 'waiting'")
      .toArray();

    if (stillWaiting > 0 || Date.now() < saleOpensAt) {
      await this.ctx.storage.setAlarm(Date.now() + QUEUE_TICK_MS);
    }
  }
}
