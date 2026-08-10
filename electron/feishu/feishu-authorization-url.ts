const TRUSTED_FEISHU_AUTHORIZATION_DOMAINS = [
  "feishu.cn",
  "larksuite.com",
] as const;

/**
 * Authorization URLs are opened outside the Electron trust boundary. Accept
 * only HTTPS pages hosted by Feishu or Lark so a malformed provider response
 * cannot turn the desktop connection flow into an arbitrary phishing link.
 */
export function isTrustedFeishuAuthorizationUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  const hostname = url.hostname.toLowerCase();
  return TRUSTED_FEISHU_AUTHORIZATION_DOMAINS.some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
  );
}
