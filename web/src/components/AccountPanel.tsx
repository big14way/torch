import { useState } from "react";
import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";
import { maxUint256, parseUnits, formatUnits } from "viem";
import { DEPLOY, FXRP, VAULT } from "../lib/config";
import { fmtFxrp, useFreeMargin, waitTx } from "../lib/hooks";

export default function AccountPanel() {
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const { data: free } = useFreeMargin(address);

  const { data: walletBal, refetch: refetchBal } = useReadContract({
    ...FXRP,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address, refetchInterval: 4000 },
  }) as { data: bigint | undefined; refetch: () => void };

  const { data: allowance, refetch: refetchAllow } = useReadContract({
    ...FXRP,
    functionName: "allowance",
    args: address ? [address, DEPLOY.vault] : undefined,
    query: { enabled: !!address },
  }) as { data: bigint | undefined; refetch: () => void };

  const [amountStr, setAmountStr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const amount = (() => {
    try {
      return parseUnits((amountStr || "0") as `${number}`, 6);
    } catch {
      return 0n;
    }
  })();

  // Guard against the #1 deposit failure: asking for more than you hold, which
  // reverts deep in the token transfer (FAssetBalanceTooLow) with no clear UI.
  const overWallet = walletBal !== undefined && amount > walletBal;
  const overFree = free !== undefined && amount > free;
  const setMax = (v: bigint | undefined) => v !== undefined && setAmountStr(formatUnits(v, 6));

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setNote(null);
    try {
      await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setNote(
        msg.includes("User rejected")
          ? "Rejected in wallet."
          : /FAssetBalanceTooLow|transfer amount exceeds balance/.test(msg)
            ? "Not enough FXRP in your wallet for that amount."
            : msg.split("\n")[0].slice(0, 140)
      );
    } finally {
      setBusy(null);
    }
  };

  const wait = async (hash: `0x${string}`) => {
    await waitTx(publicClient, hash);
  };

  const faucet = () =>
    run("faucet", async () => {
      const hash = await writeContractAsync({ ...FXRP, functionName: "faucet", args: [] });
      await wait(hash);
      refetchBal();
      setNote("10,000 tFXRP minted to your wallet.");
    });

  const deposit = () =>
    run("deposit", async () => {
      if (amount === 0n) return;
      if ((allowance ?? 0n) < amount) {
        const a = await writeContractAsync({
          ...FXRP,
          functionName: "approve",
          args: [DEPLOY.vault, maxUint256],
        });
        await wait(a);
        refetchAllow();
      }
      const hash = await writeContractAsync({ ...VAULT, functionName: "deposit", args: [amount] });
      await wait(hash);
      refetchBal();
      setNote(`Deposited ${amountStr} FXRP as margin.`);
    });

  const withdraw = () =>
    run("withdraw", async () => {
      if (amount === 0n) return;
      const hash = await writeContractAsync({ ...VAULT, functionName: "withdraw", args: [amount] });
      await wait(hash);
      refetchBal();
      setNote(`Withdrew ${amountStr} FXRP to your wallet.`);
    });

  return (
    <div className="card">
      <h2>Account</h2>

      <div className="balrow">
        <span className="k">Wallet {DEPLOY.mode === "local" ? "tFXRP" : "FXRP"}</span>
        <span className="v maxable" title="Use as amount" onClick={() => setMax(walletBal)}>
          {walletBal !== undefined ? fmtFxrp(walletBal) : "..."}
        </span>
      </div>
      <div className="balrow">
        <span className="k">Free margin</span>
        <span className="v maxable" title="Use as amount" onClick={() => setMax(free)}>
          {free !== undefined ? fmtFxrp(free) : "..."}
        </span>
      </div>

      <div className="inline-amount">
        <input
          aria-label="Amount in FXRP"
          type="text"
          inputMode="decimal"
          placeholder="0.00 FXRP — tap a balance above to fill"
          value={amountStr}
          onChange={(e) => setAmountStr(e.target.value.replace(/[^0-9.]/g, ""))}
        />
      </div>

      <div className="acct-actions">
        <button
          className="btn"
          disabled={!isConnected || !!busy || amount === 0n || overWallet}
          onClick={deposit}
        >
          {busy === "deposit" ? "Depositing..." : overWallet ? "Not enough FXRP" : "Deposit"}
        </button>
        <button
          className="btn ghost"
          disabled={!isConnected || !!busy || amount === 0n || overFree}
          onClick={withdraw}
        >
          {busy === "withdraw" ? "Withdrawing..." : overFree ? "Exceeds free margin" : "Withdraw"}
        </button>
        {DEPLOY.mode === "local" && (
          <button className="btn primary wide" disabled={!isConnected || !!busy} onClick={faucet}>
            {busy === "faucet" ? "Minting..." : "Faucet: 10,000 tFXRP"}
          </button>
        )}
        {DEPLOY.mode === "coston2" && (
          <a className="btn primary wide" href="https://faucet.flare.network" target="_blank" rel="noreferrer" style={{ textAlign: "center" }}>
            Faucet: C2FLR gas + FXRP
          </a>
        )}
      </div>

      {overWallet && walletBal !== undefined && (
        <div className="notice error">
          You only have {fmtFxrp(walletBal)} FXRP in your wallet. Tap the balance above to deposit
          all of it, or enter less.
        </div>
      )}

      {DEPLOY.mode === "coston2" && !overWallet && (
        <div className="notice">
          Need FXRP? Claim C2FLR for gas + <b>FTestXRP</b> from the{" "}
          <a href="https://faucet.flare.network" target="_blank" rel="noreferrer">
            Flare faucet
          </a>
          , then deposit it here.
        </div>
      )}

      {note && <div className="notice">{note}</div>}
    </div>
  );
}
