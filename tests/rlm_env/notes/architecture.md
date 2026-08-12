# Checkout Architecture

The checkout service should keep pricing calculations deterministic and side-effect free. Cart totals are calculated client-side for display, then verified server-side before payment capture.

Release constraints:

- No schema migrations in the checkout hotfix window.
- Checkout error rate must remain below 1.5%.
- Support should receive a rollback note for any payment or pricing change.
