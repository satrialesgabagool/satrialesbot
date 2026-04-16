/**
 * Kalshi RSA-PSS request signing.
 *
 * Kalshi requires three headers on authenticated endpoints:
 *   KALSHI-ACCESS-KEY         — your API key ID
 *   KALSHI-ACCESS-TIMESTAMP   — current ms epoch as a string
 *   KALSHI-ACCESS-SIGNATURE   — base64(RSA-PSS-SHA256(timestamp + METHOD + PATH))
 *
 * Public read endpoints (events, markets, orderbook, trades) do NOT
 * require auth. We only produce signed headers when keys are configured.
 *
 * Paper-only mode: no keys → returns empty header set → only public
 * endpoints usable. That's fine for our scanners.
 */

import { createSign, createPrivateKey, type KeyObject } from "crypto";

export interface SignedHeaders {
  "KALSHI-ACCESS-KEY"?: string;
  "KALSHI-ACCESS-TIMESTAMP"?: string;
  "KALSHI-ACCESS-SIGNATURE"?: string;
}

/**
 * Cache parsed private key objects to avoid expensive PEM parsing on
 * every HTTP request. Keyed by PEM string so different keys (e.g.
 * demo vs prod) each get their own cached entry.
 */
const keyCache = new Map<string, KeyObject>();

function getOrCreateKey(pem: string): KeyObject {
  let key = keyCache.get(pem);
  if (!key) {
    key = createPrivateKey({ key: pem, format: "pem" });
    keyCache.set(pem, key);
  }
  return key;
}

export function signRequest(
  method: string,
  pathWithPrefix: string,
  accessKey: string | undefined,
  privateKeyPem: string | undefined,
): SignedHeaders {
  if (!accessKey || !privateKeyPem) return {};

  const timestamp = Date.now().toString();
  const msg = timestamp + method.toUpperCase() + pathWithPrefix;

  const key = getOrCreateKey(privateKeyPem);

  const signer = createSign("RSA-SHA256");
  signer.update(msg);
  signer.end();

  // Kalshi requires PSS padding with MGF1-SHA256 and saltLength = digest length.
  const signature = signer.sign(
    {
      key,
      padding: 6, // crypto.constants.RSA_PKCS1_PSS_PADDING — hardcoded to avoid extra import
      saltLength: 32,
    },
    "base64",
  );

  return {
    "KALSHI-ACCESS-KEY": accessKey,
    "KALSHI-ACCESS-TIMESTAMP": timestamp,
    "KALSHI-ACCESS-SIGNATURE": signature,
  };
}
