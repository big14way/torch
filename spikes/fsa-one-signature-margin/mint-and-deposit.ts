import { encodeFunctionData, formatUnits, parseUnits } from "viem";
import { Client, Wallet } from "xrpl";
import { abi as ERC20Abi } from "../abis/ERC20";
import { publicClient } from "../utils/client";
import { computeDirectMintingPaymentAmountXrp } from "../utils/fassets";
import {
  executeDirectMintingWithData,
  findUserOperationExecuted,
  getNonce,
  getPersonalAccountAddress,
  logPersonalAccountFxrpCredit,
  normalizeXrplTransactionId,
  sendHashInstruction,
  type Call,
} from "../utils/smart-accounts";

/**
 * Torch x Flare Smart Accounts spike:
 * ONE XRPL-testnet signature -> FXRP minted to the user's PersonalAccount ->
 * approve -> TorchVault.deposit, all atomically in ONE Coston2 transaction.
 * The XRPL user never touches an EVM wallet, holds no C2FLR, sees no bridge.
 */

const TORCH_VAULT = "0x7fC640Bd0e635a6AFc3B437e80f0DE192f6FA0BA" as const;
const FXRP = "0x0b6A3645c240605887a5532109323A3E12273dc7" as const; // FTestXRP, 6 decimals
const NET_MINT_XRP = 10; // 10 XRP -> 10.000000 FXRP net to the PA

const torchVaultAbi = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "freeMargin",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

async function main() {
  const xrplClient = new Client(process.env.XRPL_TESTNET_RPC_URL!);
  const xrplWallet = Wallet.fromSeed(process.env.XRPL_SEED!);

  const personalAccount = await getPersonalAccountAddress(xrplWallet.address);
  const amountUBA = parseUnits(String(NET_MINT_XRP), 6); // FXRP UBA == XRP drops
  const paymentXrp = await computeDirectMintingPaymentAmountXrp({ netMintAmountXrp: NET_MINT_XRP });
  console.log("XRPL owner:", xrplWallet.address);
  console.log("PersonalAccount:", personalAccount);
  console.log("nonce:", await getNonce(personalAccount));
  console.log("XRPL payment amount (net mint + fees):", paymentXrp, "XRP");

  // The atomic batch the PersonalAccount executes — msg.sender = PA for both.
  const calls: Call[] = [
    {
      target: FXRP,
      value: 0n,
      data: encodeFunctionData({ abi: ERC20Abi, functionName: "approve", args: [TORCH_VAULT, amountUBA] }),
    },
    {
      target: TORCH_VAULT,
      value: 0n,
      data: encodeFunctionData({ abi: torchVaultAbi, functionName: "deposit", args: [amountUBA] }),
    },
  ];

  // --- THE ONE SIGNATURE: XRPL Payment to the Core Vault, 42-byte 0xFE memo ---
  const userSide = await sendHashInstruction({
    label: "torch-margin",
    customInstruction: calls,
    amountXrp: paymentXrp,
    personalAccount,
    xrplClient,
    xrplWallet,
  });

  // --- EXECUTOR (our EOA): FDC XRPPayment proof -> executeDirectMintingWithData ---
  const { receipt } = await executeDirectMintingWithData({
    xrplTransactionHash: userSide.xrplTransactionHash,
    data: userSide.data,
    value: userSide.totalCallValue, // 0n here
    xrplClient,
    label: "torch-margin",
    reuseExistingMint: true,
  });

  // --- ASSERTIONS ---
  findUserOperationExecuted(receipt, personalAccount, userSide.nonce); // throws if the op didn't run
  logPersonalAccountFxrpCredit({
    label: "torch-margin",
    receipt,
    personalAccount,
    xrplTransactionId: normalizeXrplTransactionId(userSide.xrplTransactionHash),
  });

  const [margin, paFxrp] = await Promise.all([
    publicClient.readContract({
      address: TORCH_VAULT,
      abi: torchVaultAbi,
      functionName: "freeMargin",
      args: [personalAccount],
    }),
    publicClient.readContract({ address: FXRP, abi: ERC20Abi, functionName: "balanceOf", args: [personalAccount] }),
  ]);
  console.log("TorchVault freeMargin[PA]:", formatUnits(margin as bigint, 6), "FXRP");
  console.log("PA residual FXRP:", formatUnits(paFxrp as bigint, 6));
  if ((margin as bigint) < amountUBA) throw new Error("freeMargin below deposited amount");

  console.log("\nRECEIPTS");
  console.log("XRPL (the one signature):  https://testnet.xrpl.org/transactions/" + userSide.xrplTransactionHash);
  console.log("Coston2 execute tx:        https://coston2-explorer.flare.network/tx/" + receipt.transactionHash);
  console.log("PersonalAccount:           https://coston2-explorer.flare.network/address/" + personalAccount);
  console.log("TorchVault:                https://coston2-explorer.flare.network/address/" + TORCH_VAULT);

  await xrplClient.disconnect();
}

void main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
