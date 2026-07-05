import { useState } from "react";
import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";
import { maxUint256, parseUnits } from "viem";
import { DEPLOY, FXRP, VAULT } from "../lib/config";
import { fmtFxrp, useFreeMargin } from "../lib/hooks";

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

  const [amountStr, setAmountStr] = useState("1000");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const amount = (() => {
    try {
      return parseUnits((amountStr || "0") as `${number}`, 6);
    } catch {
      return 0n;
    }
  })();

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setNote(null);
    try {
      await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setNote(msg.includes("User rejected") ? "Rejected in wallet." : msg.split("\n")[0].slice(0, 140));
    } finally {
      setBusy(null);
    }
  };

  const wait = async (hash: `0x${string}`) => {
    await publicClient?.waitForTransactionReceipt({ hash });
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
        <span className="v">{walletBal !== undefined ? fmtFxrp(walletBal) : "..."}</span>
      </div>
      <div className="balrow">
        <span className="k">Free margin</span>
        <span className="v">{free !== undefined ? fmtFxrp(free) : "..."}</span>
      </div>

      <div className="inline-amount">
        <input
          aria-label="Amount in FXRP"
          type="text"
          inputMode="decimal"
          value={amountStr}
          onChange={(e) => setAmountStr(e.target.value.replace(/[^0-9.]/g, ""))}
        />
      </div>

      <div className="acct-actions">
        <button className="btn" disabled={!isConnected || !!busy || amount === 0n} onClick={deposit}>
          {busy === "deposit" ? "Depositing..." : "Deposit"}
        </button>
        <button className="btn ghost" disabled={!isConnected || !!busy || amount === 0n} onClick={withdraw}>
          {busy === "withdraw" ? "Withdrawing..." : "Withdraw"}
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

      {DEPLOY.mode === "coston2" && (
        <div className="notice">
          In the faucet, claim C2FLR for gas, then pick <b>FTestXRP</b> in the token dropdown for
          margin. Deposit it here once it lands.
        </div>
      )}

      {note && <div className="notice">{note}</div>}
    </div>
  );
}
