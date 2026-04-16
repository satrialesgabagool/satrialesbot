/**
 * Kalshi API authentication — RSA-PSS signature scheme.
 *
 * Every authenticated request needs three headers:
 *   KALSHI-ACCESS-KEY       — API key ID (UUID)
 *   KALSHI-ACCESS-TIMESTAMP — current time in ms
 *   KALSHI-ACCESS-SIGNATURE — Base64 RSA-PSS(SHA256) of "{timestamp}{METHOD}{path}"
 *
 * The private key is a PEM file obtained from the Kalshi dashboard.
 */

import * as crypto from "crypto";
import { readFileSync } from "fs";

export interface KalshiCredentials {
  apiKeyId: string;
  privateKeyPem: string;
}

/**
 * Load credentials from API key ID + PEM file path.
 */
export function loadCredentials(apiKeyId: string, privateKeyPath: string): KalshiCredentials {
  const pem = readFileSync(privateKeyPath, "utf-8");
  return { apiKeyId, privateKeyPem: pem };
}

/**
 * Load credentials from environment variables.
 * Expects KALSHI_API_KEY_ID and either KALSHI_PRIVATE_KEY_PATH or KALSHI_PRIVATE_KEY_PEM.
 */
export function loadCredentialsFromEnv(): KalshiCredentials | null {
  const apiKeyId = process.env.KALSHI_API_KEY_ID;
  if (!apiKeyId) return null;

  const keyPath = process.env.KALSHI_PRIVATE_KEY_PATH;
  const keyPem = process.env.KALSHI_PRIVATE_KEY_PEM;

  if (keyPath) {
    return loadCredentials(apiKeyId, keyPath);
  }

  if (keyPem) {
    return { apiKeyId, privateKeyPem: keyPem };
  }

  return null;
}

/**
 * Sign a request for Kalshi API authentication.
 *
 * @param creds      — API key + private key PEM
 * @param method     — HTTP method (GET, POST, DELETE, etc.)
 * @param path       — Full path including /trade-api/v2 prefix, WITHOUT query params
 * @param timestampMs — Current time in milliseconds (optional, defaults to now)
 * @returns Headers object to merge into request
 */
export function signRequest(
  creds: KalshiCredentials,
  method: string,
  path: string,
  timestampMs?: string,
): Record<string, string> {
  const ts = timestampMs ?? Date.now().toString();

  // Strip query params — Kalshi only signs the path portion
  const pathOnly = path.split("?")[0];

  // Message to sign: "{timestamp}{METHOD}{path}"
  const message = `${ts}${method.toUpperCase()}${pathOnly}`;

  const signature = crypto.sign("RSA-SHA256", Buffer.from(message), {
    key: creds.privateKeyPem,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });

  return {
    "KALSHI-ACCESS-KEY": creds.apiKeyId,
    "KALSHI-ACCESS-TIMESTAMP": ts,
    "KALSHI-ACCESS-SIGNATURE": signature.toString("base64"),
  };
}
