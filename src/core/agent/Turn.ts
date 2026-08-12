import { shortId } from "../../utils/id.ts";
import type { TurnStatus } from "../bus/events.ts";

/** Lightweight value object identifying a single request/response turn. */
export class Turn {
	readonly id: string;
	readonly startedAt: number;
	status: TurnStatus = "in_progress";

	constructor(id: string = shortId("turn"), startedAt: number = Date.now()) {
		this.id = id;
		this.startedAt = startedAt;
	}

	durationMs(): number {
		return Math.max(0, Date.now() - this.startedAt);
	}
}
