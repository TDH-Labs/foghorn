// Minimal OAuth 1.0a HMAC-SHA1 signer for the X API v2 user context.
// No dependency: percent-encoding per RFC 3986, sorted param signature base,
// Authorization header builder. Used by the connector (read validation) and
// the Phase-6 X adapter (posting).

import { createHmac, randomBytes } from "node:crypto";

export interface OAuth1Creds {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

export function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function oauth1Header(
  creds: OAuth1Creds,
  method: string,
  url: string,
  extraParams: Record<string, string> = {},
  nonce: string = randomBytes(16).toString("hex"),
  timestamp: string = String(Math.floor(Date.now() / 1000)),
): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp,
    oauth_token: creds.accessToken,
    oauth_version: "1.0",
  };

  const u = new URL(url);
  const queryParams: Record<string, string> = {};
  u.searchParams.forEach((v, k) => { queryParams[k] = v; });
  const baseUrl = `${u.protocol}//${u.host}${u.pathname}`;

  const allParams = { ...oauthParams, ...queryParams, ...extraParams };
  // OAuth 1.0a mandates byte-order sort of the ENCODED key/value pairs.
  const paramString = Object.keys(allParams)
    .map((k) => [rfc3986(k), rfc3986(allParams[k]!)] as const)
    .sort(([ak, av], [bk, bv]) => (ak === bk ? (av < bv ? -1 : av > bv ? 1 : 0) : ak < bk ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const baseString = [method.toUpperCase(), rfc3986(baseUrl), rfc3986(paramString)].join("&");
  const signingKey = `${rfc3986(creds.consumerSecret)}&${rfc3986(creds.accessTokenSecret)}`;
  const signature = createHmac("sha1", signingKey).update(baseString).digest("base64");

  const headerParams = { ...oauthParams, oauth_signature: signature };
  return (
    "OAuth " +
    Object.keys(headerParams)
      .sort()
      .map((k) => `${rfc3986(k)}="${rfc3986(headerParams[k as keyof typeof headerParams]!)}"`)
      .join(", ")
  );
}
