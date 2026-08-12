export interface ResizeStabilizerState {
	isResizing: boolean;
	resizeEpoch: number;
}

export interface ResizeStabilizerOptions {
	isTerminal: boolean;
	write: (data: string) => void;
}
