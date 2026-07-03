/**
 * TEE attestation surface.
 *
 * Dev mode (local): no enclave, the executor key comes from .env.
 *
 * Production: the agent runs inside Google Cloud Confidential Space (the stack
 * Flare used for the Verifiable AI hackathon and the stack FCC Protocol Managed
 * Wallets launch on), where:
 *
 *  1. The executor key is GENERATED inside the enclave and never exported
 *     (see index.ts: no EXECUTOR_PRIVATE_KEY -> generatePrivateKey() in-enclave).
 *  2. The launcher serves a vTPM attestation token binding the running container
 *     IMAGE DIGEST to the workload, fetched below over the local unix socket.
 *  3. That token + digest are published so anyone can verify the exact code
 *     controlling the executor role.
 *
 * Migration path: when Flare Confidential Compute ships Protocol Managed Wallets
 * on Songbird, the executor role moves from this single app-run TEE to the
 * protocol's quorum of TEEs. The vault contract does not change.
 */
import http from "node:http";
import { existsSync } from "node:fs";

// Confidential Space launcher exposes the token server on this unix socket.
const TEE_SOCKET = "/run/container_launcher/teeserver.sock";

export interface AttestationInfo {
  mode: "dev" | "confidential-space";
  imageDigest?: string;
  token?: string;
  note: string;
}

/** True when running inside a Confidential Space workload. */
export function inConfidentialSpace(): boolean {
  return process.env.CONFIDENTIAL_SPACE === "1" || existsSync(TEE_SOCKET);
}

/** Fetch an attestation token (OIDC JWT) from the launcher's token server. */
export function fetchAttestationToken(audience = "torch-executor", nonces: string[] = []): Promise<string> {
  const body = JSON.stringify({ audience, nonces, token_type: "OIDC" });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: TEE_SOCKET,
        path: "/v1/token",
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () =>
          res.statusCode === 200 ? resolve(data.trim()) : reject(new Error(`teeserver ${res.statusCode}: ${data}`))
        );
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function decodeJwtPayload(jwt: string): Record<string, any> | null {
  const part = jwt.split(".")[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch {
    return null;
  }
}

export async function getAttestation(): Promise<AttestationInfo> {
  if (!inConfidentialSpace()) {
    return { mode: "dev", note: "Dev mode: no enclave. Executor key loaded from .env for local testing." };
  }
  try {
    const token = await fetchAttestationToken();
    const claims = decodeJwtPayload(token);
    const digest = claims?.submods?.container?.image_digest ?? process.env.IMAGE_DIGEST;
    return {
      mode: "confidential-space",
      imageDigest: digest,
      token,
      note: `Confidential Space attestation live. Image digest ${digest ?? "unknown"}, bound by Google vTPM.`,
    };
  } catch (e) {
    return {
      mode: "confidential-space",
      imageDigest: process.env.IMAGE_DIGEST,
      note: `Confidential Space env, but attestation fetch failed: ${(e as Error).message}`,
    };
  }
}
