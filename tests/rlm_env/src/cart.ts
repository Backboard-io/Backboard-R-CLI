import { applyDiscount } from "./discounts";

export interface CartItem {
	sku: string;
	unitCents: number;
	quantity: number;
	discountCents?: number;
}

export function calculateCartTotal(items: CartItem[]): number {
	return items.reduce((total, item) => {
		const subtotal = item.unitCents * item.quantity;
		if (!item.discountCents) return total + subtotal;
		return total + applyDiscount(subtotal, -item.discountCents);
	}, 0);
}
