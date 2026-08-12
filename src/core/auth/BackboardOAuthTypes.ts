export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface BackboardOAuthTokenResponse {
	access_token: string;
	token_type: string;
	expires_in: number;
	refresh_token?: string;
	scope?: string;
	id_token: string | null;
	assistant_id: string | null;
	backboard_api_key: string | null;
	personal_api_key?: string | null;
	selected_client_name?: string | null;
}

export interface BackboardOAuthLoginResult {
	authorizeUrl: string;
	redirectUri: string;
	token: BackboardOAuthTokenResponse;
}

export interface BackboardDeviceCodeResponse {
	device_code: string;
	user_code: string;
	verification_uri: string;
	verification_uri_complete: string;
	expires_in: number;
	interval: number;
}

export interface BackboardDeviceLoginOptions {
	apiUrl?: string;
	clientId?: string;
	scope?: string;
	timeoutMs?: number;
	onDeviceCode?: (response: BackboardDeviceCodeResponse) => void;
	fetchFn?: FetchFn;
}

export interface RequestDeviceCodeInput {
	apiUrl: string;
	clientId: string;
	scope: string;
	fetchFn?: FetchFn;
}

export interface ExchangeDeviceCodeInput {
	apiUrl: string;
	clientId: string;
	deviceCode: string;
	fetchFn?: FetchFn;
}

export interface BackboardSsoLoginOptions {
	onDeviceCode?: (response: BackboardDeviceCodeResponse) => void;
}
