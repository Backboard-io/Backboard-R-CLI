import { describe, expect, it } from "bun:test";
import {
	exchangeDeviceCode,
	loadOAuthClientId,
	requestDeviceCode,
	runBackboardDeviceLogin,
} from "../src/core/auth/BackboardOAuth.ts";

describe("Backboard OAuth login", () => {
	it("falls back to the baked-in client id when the environment is empty", () => {
		expect(loadOAuthClientId({})).toBe("Backboard_oauth_q_cli");
	});

	it("loads the OAuth client id from the environment", () => {
		expect(
			loadOAuthClientId({ BACKBOARD_OAUTH_CLIENT_ID: " oauth-client " }),
		).toBe("oauth-client");
	});

	it("requests device login without openid by default", async () => {
		const requests: { url: string; init: RequestInit }[] = [];
		const fetchFn = async (
			url: string,
			init?: RequestInit,
		): Promise<Response> => {
			requests.push({ url: String(url), init: init ?? {} });
			if (String(url).endsWith("/oauth/device/code")) {
				return new Response(
					JSON.stringify({
						device_code: "Backboard_device_test",
						user_code: "ABCD-EFGH",
						verification_uri: "https://app.backboard.io/oauth/device",
						verification_uri_complete:
							"https://app.backboard.io/oauth/device?user_code=ABCD-EFGH",
						expires_in: 300,
						interval: 1,
					}),
					{ status: 200 },
				);
			}
			return new Response(
				JSON.stringify({
					access_token: "Backboard_at_test",
					token_type: "Bearer",
					expires_in: 3600,
					refresh_token: "Backboard_rt_test",
					scope: "email profile",
					id_token: null,
					assistant_id: "assistant_123",
					backboard_api_key: "espr_test",
				}),
				{ status: 200 },
			);
		};

		await runBackboardDeviceLogin({
			apiUrl: "https://app.backboard.io/api",
			clientId: "client-123",
			fetchFn,
		});

		const body = requests[0]?.init.body;
		if (!(body instanceof URLSearchParams)) {
			throw new Error("Expected URLSearchParams device-code request body.");
		}
		expect(body.get("scope")).toBe("email profile");
	});

	it("requests a device code with client id and scope", async () => {
		const requests: { url: string; init: RequestInit }[] = [];
		const fetchFn = async (
			url: string,
			init?: RequestInit,
		): Promise<Response> => {
			requests.push({ url: String(url), init: init ?? {} });
			return new Response(
				JSON.stringify({
					device_code: "Backboard_device_test",
					user_code: "ABCD-EFGH",
					verification_uri: "https://app.backboard.io/oauth/device",
					verification_uri_complete:
						"https://app.backboard.io/oauth/device?user_code=ABCD-EFGH",
					expires_in: 300,
					interval: 5,
				}),
				{ status: 200 },
			);
		};

		const response = await requestDeviceCode({
			apiUrl: "https://app.backboard.io/api",
			clientId: "client-123",
			scope: "openid email profile",
			fetchFn,
		});

		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe(
			"https://app.backboard.io/api/oauth/device/code",
		);
		const body = requests[0]?.init.body;
		if (!(body instanceof URLSearchParams)) {
			throw new Error("Expected URLSearchParams device-code request body.");
		}
		expect(body.get("client_id")).toBe("client-123");
		expect(body.get("scope")).toBe("openid email profile");
		expect(response.user_code).toBe("ABCD-EFGH");
		expect(response.interval).toBe(5);
	});

	it("exchanges an approved device code for a token", async () => {
		const requests: { url: string; init: RequestInit }[] = [];
		const fetchFn = async (
			url: string,
			init?: RequestInit,
		): Promise<Response> => {
			requests.push({ url: String(url), init: init ?? {} });
			return new Response(
				JSON.stringify({
					access_token: "Backboard_at_test",
					token_type: "Bearer",
					expires_in: 3600,
					refresh_token: "Backboard_rt_test",
					scope: "openid email profile",
					id_token: null,
					assistant_id: "assistant_123",
					backboard_api_key: "espr_test",
				}),
				{ status: 200 },
			);
		};

		const token = await exchangeDeviceCode({
			apiUrl: "https://app.backboard.io/api",
			clientId: "client-123",
			deviceCode: "Backboard_device_test",
			fetchFn,
		});

		expect(requests[0]?.url).toBe("https://app.backboard.io/api/oauth/token");
		const body = requests[0]?.init.body;
		if (!(body instanceof URLSearchParams)) {
			throw new Error("Expected URLSearchParams token request body.");
		}
		expect(body.get("grant_type")).toBe(
			"urn:ietf:params:oauth:grant-type:device_code",
		);
		expect(body.get("client_id")).toBe("client-123");
		expect(body.get("device_code")).toBe("Backboard_device_test");
		expect(token.backboard_api_key).toBe("espr_test");
	});

	it("accepts token responses without a refresh token", async () => {
		const token = await exchangeDeviceCode({
			apiUrl: "https://app.backboard.io/api",
			clientId: "client-123",
			deviceCode: "Backboard_device_test",
			fetchFn: async () =>
				new Response(
					JSON.stringify({
						access_token: "Backboard_at_test",
						token_type: "Bearer",
						expires_in: 3600,
						scope: "openid email profile",
						id_token: null,
						assistant_id: "assistant_123",
						backboard_api_key: "espr_test",
					}),
					{ status: 200 },
				),
		});

		expect(token.refresh_token).toBeUndefined();
		expect(token.backboard_api_key).toBe("espr_test");
	});

	it("surfaces pending device-code token responses", async () => {
		await expect(
			exchangeDeviceCode({
				apiUrl: "https://app.backboard.io/api",
				clientId: "client-123",
				deviceCode: "Backboard_device_test",
				fetchFn: async () =>
					new Response(
						JSON.stringify({
							error: "authorization_pending",
							error_description: "Device authorization is still pending",
						}),
						{ status: 400 },
					),
			}),
		).rejects.toThrow("authorization_pending");
	});
});
