import { BlockList } from "node:net";

export const FETCH_URL_MAX_TEXT = 40_000;
export const FETCH_URL_MAX_RESPONSE_BYTES = 160_000;
export const FETCH_URL_MAX_REDIRECTS = 5;
export const FETCH_URL_PRIVATE_NETWORK_ERROR =
	"FetchUrl cannot access localhost or private networks.";

export const FETCH_URL_PRIVATE_ADDRESSES = new BlockList();

FETCH_URL_PRIVATE_ADDRESSES.addSubnet("0.0.0.0", 8, "ipv4");
FETCH_URL_PRIVATE_ADDRESSES.addSubnet("10.0.0.0", 8, "ipv4");
FETCH_URL_PRIVATE_ADDRESSES.addSubnet("100.64.0.0", 10, "ipv4");
FETCH_URL_PRIVATE_ADDRESSES.addSubnet("127.0.0.0", 8, "ipv4");
FETCH_URL_PRIVATE_ADDRESSES.addSubnet("169.254.0.0", 16, "ipv4");
FETCH_URL_PRIVATE_ADDRESSES.addSubnet("172.16.0.0", 12, "ipv4");
FETCH_URL_PRIVATE_ADDRESSES.addSubnet("192.168.0.0", 16, "ipv4");
FETCH_URL_PRIVATE_ADDRESSES.addSubnet("198.18.0.0", 15, "ipv4");
FETCH_URL_PRIVATE_ADDRESSES.addSubnet("224.0.0.0", 4, "ipv4");
FETCH_URL_PRIVATE_ADDRESSES.addAddress("::", "ipv6");
FETCH_URL_PRIVATE_ADDRESSES.addAddress("::1", "ipv6");
FETCH_URL_PRIVATE_ADDRESSES.addSubnet("fc00::", 7, "ipv6");
FETCH_URL_PRIVATE_ADDRESSES.addSubnet("fe80::", 10, "ipv6");
