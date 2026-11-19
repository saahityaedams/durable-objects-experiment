/** Seat shape shared by the seat map and checkout. */
export interface SeatInfo {
  seat_id: string;
  section: string;
  row: number;
  number: number;
  price: number;
  status: "available" | "held" | "booked";
  hold_expires_at: number | null;
  isMine: boolean;
}

/** "Section A, row 3, seat 3" */
export function describeSeat(seat: Pick<SeatInfo, "section" | "row" | "number">) {
  return `Section ${seat.section}, row ${seat.row}, seat ${seat.number}`;
}
