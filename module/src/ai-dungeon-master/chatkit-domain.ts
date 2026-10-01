/** The official quickstart's development key applies only to loopback origins. */
export function chatKitDomainKey(configured: unknown, hostname: string): string {
  const value = typeof configured === "string" ? configured.trim() : "";
  if (value) return value;
  return ["localhost", "127.0.0.1", "[::1]"].includes(hostname) ? "local-dev" : "";
}
