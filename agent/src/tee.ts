/**
 * TEE attestation surface.
 *
 * Locally this runs in "dev" mode: no enclave, the executor key comes from
 * .env. In production the agent runs inside Google Cloud Confidential Space
 * (the same stack Flare used for the Verifiable AI hackathon and the stack
 * FCC Protocol Managed Wallets launch on), where:
 *
 *  1. The executor key is GENERATED inside the enclave and never exported.
 *  2. The enclave produces a vTPM attestation token binding the running
 *     container image digest to the executor address.
 *  3. That attestation is published so anyone can verify the exact code
 *     controlling the executor role.
 *  4. The Hyperliquid API wallet key is also enclave-generated. API wallets
 *     cannot withdraw on Hyperliquid, so custody risk is capped by design.
 *
 * Deployment sketch (verify against current GCP + Flare docs before demo):
 *   - Build the agent image, push to Artifact Registry.
 *   - Create a Confidential Space VM (TDX) with the image and a workload
 *     identity pool that releases secrets only to the measured image digest.
 *   - Publish the attestation token + image digest in the repo and on-chain
 *     (bytes32 digest stored via a small AttestationRegistry, roadmap).
 *
 * Migration path: when Flare Confidential Compute ships Protocol Managed
 * Wallets on Songbird, the executor role moves from this single app-run TEE
 * to the protocol's quorum of TEEs. The vault contract does not change.
 */

export interface AttestationInfo {
  mode: "dev" | "confidential-space";
  imageDigest?: string;
  note: string;
}

export function getAttestation(): AttestationInfo {
  // Confidential Space exposes an attestation token at a well-known local
  // endpoint inside the workload. Wire this up when deploying to GCP.
  if (process.env.CONFIDENTIAL_SPACE === "1") {
    return {
      mode: "confidential-space",
      imageDigest: process.env.IMAGE_DIGEST,
      note: "Running inside Confidential Space. Attestation token served by the launcher.",
    };
  }
  return {
    mode: "dev",
    note: "Dev mode: no enclave. Executor key loaded from .env for local testing.",
  };
}
