import { http, createConfig } from "wagmi";
import { defineChain, type Abi } from "viem";
import { injected, walletConnect } from "wagmi/connectors";
import deployments from "../generated/deployments.json";
import vaultAbiJson from "../generated/TorchVault.abi.json";
import erc20AbiJson from "../generated/ERC20.abi.json";
import fdcJson from "../generated/fdc.json";

export const DEPLOY = deployments as {
  chainId: number;
  network: string;
  mode: "local" | "coston2";
  vault: `0x${string}`;
  fxrp: `0x${string}`;
  oracle: `0x${string}`;
  executor: `0x${string}`;
  markets: { key: string; id: `0x${string}`; feedId: `0x${string}` }[];
};

export const VAULT_ABI = vaultAbiJson as Abi;
export const ERC20_ABI = erc20AbiJson as Abi;

// FDC Web2Json attestation record (written by contracts/scripts/fdcAttest.ts).
export const FDC = fdcJson as {
  fdcConsumer: `0x${string}`;
  network: string;
  vault?: `0x${string}`;
  attestTx?: `0x${string}`;
  attestedOid?: string;
  attestedCoin?: string;
  positionAttest?: { positionId: string; oid: string; tx: `0x${string}` };
};

// Feedback form (Google Form). To wire it: create the form, open its ⋮ menu →
// "Get pre-filled link", type the literal word WALLET into the wallet-address
// field, click "Get link", and paste that URL below. The app swaps WALLET for
// the connected wallet so testers never mistype the address they'll be paid to.
export const FEEDBACK_FORM_PREFILL =
  "https://docs.google.com/forms/d/e/1FAIpQLScZiBLi9YJ5wD5mOjb9bS3_Hs2TVIgzz27dOTOW5b0TMhSIwA/viewform?usp=pp_url&entry.1182540619=WALLET";
export const FEEDBACK_CONFIGURED = !FEEDBACK_FORM_PREFILL.includes("REPLACE_ME");
export function feedbackUrl(address?: `0x${string}`): string {
  if (address) return FEEDBACK_FORM_PREFILL.replace("WALLET", address);
  return FEEDBACK_FORM_PREFILL.split("?")[0]; // blank form when no wallet is connected
}

export const localhostChain = defineChain({
  id: 31337,
  name: "Localhost",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
});

export const coston2 = defineChain({
  id: 114,
  name: "Flare Testnet Coston2",
  nativeCurrency: { name: "Coston2 Flare", symbol: "C2FLR", decimals: 18 },
  rpcUrls: { default: { http: ["https://coston2-api.flare.network/ext/C/rpc"] } },
  blockExplorers: {
    default: { name: "Coston2 Explorer", url: "https://coston2-explorer.flare.network" },
  },
  testnet: true,
});

export const ACTIVE_CHAIN = DEPLOY.chainId === 114 ? coston2 : localhostChain;

// WalletConnect Cloud project id — a PUBLIC identifier (not a secret), safe in
// the bundle. Create one free at https://cloud.reown.com and paste it here to
// enable the mobile wallet picker (MetaMask mobile, Bifrost, Trust, ...).
// Empty string = WalletConnect disabled; mobile browsers fall back to the
// MetaMask deep link in the header.
export const WC_PROJECT_ID = "1eebe528ca0ce94a99ceaa2e915058d7";

export const wagmiConfig = createConfig({
  chains: [ACTIVE_CHAIN],
  connectors: [
    injected(),
    ...(WC_PROJECT_ID
      ? [
          walletConnect({
            projectId: WC_PROJECT_ID,
            showQrModal: true,
            metadata: {
              name: "Torch",
              description: "XRP-margined perps on Flare",
              url: "https://usetorch.vercel.app",
              icons: [],
            },
          }),
        ]
      : []),
  ],
  transports: {
    [localhostChain.id]: http("http://127.0.0.1:8545"),
    [coston2.id]: http("https://coston2-api.flare.network/ext/C/rpc"),
  } as Record<number, ReturnType<typeof http>>,
});

export const VAULT = { address: DEPLOY.vault, abi: VAULT_ABI } as const;
export const FXRP = { address: DEPLOY.fxrp, abi: ERC20_ABI } as const;

// Position status enum mirror of TorchVault.Status
export const STATUS = [
  "None",
  "Requested",
  "Open",
  "Closing",
  "Closed",
  "Liquidated",
  "Cancelled",
] as const;

export type Position = {
  id: bigint;
  owner: `0x${string}`;
  market: `0x${string}`;
  isLong: boolean;
  marginFxrp: bigint;
  sizeUsd6: bigint;
  entryPrice6: bigint;
  exitPrice6: bigint;
  pnlFxrp: bigint;
  hlOid: bigint;
  status: number;
  openedAt: bigint;
  closedAt: bigint;
};
