export const FINAL_VERIFICATION_NUDGE = `Before finalizing, silently review the work against the user's original request.

Check only what matters:
- Required files, output formats, command behavior, and stated acceptance criteria are satisfied.
- Relevant validators or tests were run, or the strongest practical equivalent was used.
- Changed code is coherent with nearby patterns and has no obvious runtime errors, broken imports, or contract mismatches.

If anything is missing, broken, unverified, or messy, fix it now using tools. If everything is already verified, respond with a concise final answer using Markdown section headings '##" that you choose and believe are important and aligns what was done to the user request; put short and simple to understand bullets under each heading only when useful. Omit any section that would only say "None".`;
