import type { FileLeaseOptions } from "../../utils/FileLease.ts";

export const PROVIDER_KEY_LEASE_SUFFIX = ".lock";

export const PROVIDER_KEY_LEASE_OPTIONS: FileLeaseOptions = {
	label: "provider key store",
	timeoutMs: 10_000,
	retryMs: 25,
	invalidOwnerStaleMs: 30_000,
};
