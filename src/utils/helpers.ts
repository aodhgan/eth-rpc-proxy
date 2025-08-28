import type { MethodMatcher } from "../ProxyServer";
import type { RawData } from "ws";

export function rawDataToUint8OrString(data: RawData): string | Uint8Array {
	if (typeof data === "string") return data;
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (Array.isArray(data)) return Buffer.concat(data); // Buffer[] -> Buffer (Uint8Array)
	return new Uint8Array(data as Buffer);
}

export function rawDataToString(data: RawData): string {
	if (typeof data === "string") return data;
	if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
	if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
	return (data as Buffer).toString("utf8");
}

export function truncateForLog(s: string, max = 2000): string {
	return s.length > max ? s.slice(0, max) + "…" : s;
}

export function matches(m: MethodMatcher, method: string): boolean {
	if (typeof m === "string") return method === m;
	if (m instanceof RegExp) return m.test(method);
	return m(method);
}
