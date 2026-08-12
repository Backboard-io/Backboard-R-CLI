export function applyDiscount(
	amountCents: number,
	discountCents: number,
): number {
	if (discountCents < 0) {
		throw new Error("discountCents must be positive");
	}
	return Math.max(0, amountCents - discountCents);
}
