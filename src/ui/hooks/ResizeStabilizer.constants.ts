export const RESIZE_SETTLE_DELAY_MS = 150;
// 2J erases the visible screen, 3J erases scrollback, H homes the cursor.
// 3J matters: the transcript reprint (<Static> remount) replaces old output,
// so any pre-clear copy that scrolled into scrollback must go too — otherwise
// the terminal shows two copies of the transcript after a resize.
export const CLEAR_VISIBLE_SCREEN = "\x1b[2J\x1b[3J\x1b[H";
