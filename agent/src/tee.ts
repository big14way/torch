/**
 * TEE attestation surface. Two real backends plus dev mode:
 *   - Google Confidential Space (teeserver socket, vTPM OIDC token)
 *   - Phala Cloud / dstack (Intel TDX; RA report binds image + compose hash)
 *
 * In any enclave the executor key is GENERATED inside the TEE and never
 * exported (see index.ts). The operator then points the vault at its address
 * via setExecutor(). Migration path unchanged: the role moves to Flare Protocol
 * Managed Wallets when FCC ships on Songbird; the vault contract does not change.
 */
import http from "node:http";
import { existsSync } from "node:fs";

const CS_SOCKET = "/run/container_launcher/teeserver.sock"; // Confidential Space
const DSTACK_SOCKET = "/var/run/dstack.sock"; // Phala Cloud / dstack

export interface AttestationInfo {
  mode: "dev" | "confidential-space" | "dstack";
  imageDigest?: string;
  token?: string;
  note: string;
}

/** Running inside a Google Confidential Space workload. */
export function inConfidentialSpace(): boolean {
  return process.env.CONFIDENTIAL_SPACE === "1" || existsSync(CS_SOCKET);
}

/** Running inside a Phala Cloud / dstack (Intel TDX) enclave. */
export function inDstack(): boolean {
  return process.env.DSTACK === "1" || existsSync(DSTACK_SOCKET);
}

/** Any TEE: the agent should generate its executor key in-enclave. */
export function inEnclave(): boolean {
  return inConfidentialSpace() || inDstack() || process.env.ENCLAVE_KEYGEN === "1";
}

/** Fetch a Confidential Space attestation token (OIDC JWT) from the launcher. */
export function fetchAttestationToken(audience = "torch-executor", nonces: string[] = []): Promise<string> {
  const body = JSON.stringify({ audience, nonces, token_type: "OIDC" });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: CS_SOCKET,
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
  if (inConfidentialSpace()) {
    try {
      const token = await fetchAttestationToken();
      const digest = decodeJwtPayload(token)?.submods?.container?.image_digest ?? process.env.IMAGE_DIGEST;
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
        note: `Confidential Space env, attestation fetch failed: ${(e as Error).message}`,
      };
    }
  }
  if (inDstack() || process.env.ENCLAVE_KEYGEN === "1") {
    return {
      mode: "dstack",
      imageDigest: process.env.IMAGE_DIGEST,
      note: "Phala Cloud / dstack (Intel TDX) enclave. RA report binds the image + compose hash; verify at the CVM's attestation page.",
    };
  }
  return { mode: "dev", note: "Dev mode: no enclave. Executor key loaded from .env for local testing." };
}
