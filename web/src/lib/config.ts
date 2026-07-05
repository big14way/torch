import { http, createConfig } from "wagmi";
import { defineChain, type Abi } from "viem";
import { injected } from "wagmi/connectors";
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

export const wagmiConfig = createConfig({
  chains: [ACTIVE_CHAIN],
  connectors: [injected()],
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
