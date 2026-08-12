import { useReadContract } from "wagmi";
import { VAULT } from "../lib/config";
import { fmtFxrp, useExecutorStatus } from "../lib/hooks";

/**
 * The counterweight to every claim on this page. A verification page that only
 * lists what we can prove is marketing; the useful half is the part that says
 * what is not proven yet. Written after an adversarial audit of our own code
 * (Aug 1) and kept current as features ship — stop-loss orders, per-fill
 * attestation and payout caps each added a limitation worth naming, and a
 * limitations list that lags the product is worse than none.
 *
 * Two values are read live rather than typed: the execution mode comes from
 * the enclave's own status endpoint and the insurance fund from the vault, so
 * neither can drift out of date the way hand-written copy does.
 */
export default function Honesty() {
  const { status, routesToExchange } = useExecutorStatus();
  const mode = status?.executionMode;
  const { data: insuranceRaw } = useReadContract({
    ...VAULT,
    functionName: "insuranceFund",
    query: { refetchInterval: 30_000 },
  });
  const insurance = insuranceRaw as bigint | undefined;

  return (
    <div className="card verify-card">
      <h2>WHAT IS NOT PROVEN</h2>

      <div className={`modeline ${routesToExchange ? "on" : ""}`}>
        <span className="modedot" aria-hidden="true" />
        <span>
        {mode === undefined ? (
          <>Execution mode: unreachable right now. Assume the exchange leg is not live.</>
        ) : routesToExchange ? (
          <>
            Execution mode <b>{mode}</b>: venue-listed markets route to the real exchange book —
            XRP does not. That is a status line, not a proof; everything below is what it still
            does not buy you.
          </>
        ) : (
          <>
            Execution mode <b>mock</b>: the enclave settles at the FTSO mark and{" "}
            <b>no order reaches an exchange right now</b>. The Hyperliquid leg has been proven
            separately on testnet and flipping to it is a config change, not new code.
          </>
        )}
        </span>
      </div>

      <ul className="verify-links">
        <li>
          <b>Your stop is an instruction to the executor, not a guarantee.</b> Only the executor
          can fire a stop-loss or take-profit. The contract makes it re-read FTSO and refuses an
          uncrossed trigger — it cannot fire one early — but there is no button that lets you fire
          your own. If the agent is down your stop does not fire, and nothing starts a clock on
          your behalf: you request a close and wait it out like any other exit. A position with a
          close already pending has its stop switched off until you retract it. And when a trigger
          does fire it settles at the oracle mark at that moment, not the price you typed — a gap
          past your stop settles past your stop, on purpose, because clamping to your exact number
          would make a position unclosable exactly when the stop matters most.
        </li>
        <li>
          <b>Winning payouts are capped at the insurance fund.</b> Profit is paid from an explicit
          on-chain fund{insurance !== undefined ? <> — currently {fmtFxrp(insurance)} FXRP</> : null}
          , and a win larger than that balance pays the balance: the vault emits{" "}
          <code>PayoutCapped</code> and your settled row shows what was actually paid beside the
          full PnL. On testnet the fund is deliberately small and shrinks as winners draw on it,
          so the order ticket warns you before you size into a cap rather than after.
        </li>
        <li>
          <b>The attestation proves a fill exists, not that it matches your position.</b> Flare's
          validators re-fetch the exchange and prove on-chain that the order id the vault recorded
          really exists in our account with the right market and side. They do not compare its
          price, its size, or its timestamp to the position. It proves co-existence, not causation
          — and it covers the <b>entry</b> fill only: the exit that actually sets your PnL carries
          no exchange order id, so it cannot be attested at all.
        </li>
        <li>
          <b>The entry price is gated; the exit price is not.</b> Since Aug 12 the vault will not
          accept an entry price without a signature from an enclave Flare currently attests
          (extension 66154, checked on-chain against Flare's TEE registry) — so the operator can
          send the transaction but cannot choose the number in it. That guard covers the entry
          only. Your exit is still an operator-reported price, bounded by the FTSO band and the
          never-worse-than-oracle rule, but not signed by anything. And the FDC receipts remain
          receipts: they arrive automatically for every venue-routed fill, and no vault code path
          reads them.
        </li>
        <li>
          <b>Exchange routing will not cover every market.</b> Hyperliquid's testnet does not
          list XRP: even when the exchange leg is on, XRP fills settle at the FTSO mark with no
          exchange order id — unhedged, and with nothing for FDC to attest. Only fills on
          venue-listed markets (BTC, ETH and others) carry a real order id and can earn an
          on-chain receipt.
        </li>
        <li>
          <b>The executor still has bounded discretion.</b> It cannot invent a price: every
          settlement must sit within 1.5% of the oracle, and the live vault additionally refuses
          any price worse for you than the oracle itself. Within that band it chooses. If it
          stalls, a close you have already requested is never stuck — retract it for free at any
          time, or two hours after you asked, answered or not, settle yourself at the live oracle
          price with no executor involved. That two-hour escape covers a requested close only; an
          untouched stop has no such timer, per the first note above. One more edge worth naming:
          a position with a pending close is still marked to market and can be liquidated until it
          actually settles.
        </li>
        <li>
          <b>The owner key is a real trust assumption.</b> One address can repoint the oracle and
          the executor, move the caps and parameters, and withdraw from the insurance fund. There
          is no timelock yet. On testnet that is a deliberate tradeoff for iteration speed; it must
          change before real money.
        </li>
        <li>
          <b>The retired v1 vault is still out there.</b> Torch moved to a new vault on Aug 6. The
          old one keeps its full trading history on-chain and still holds a handful of open
          positions, but it has no self-close, its executor is now a plain operator key rather than
          the enclave, and this app does not talk to it. If you traded on v1 and still have a
          position open, it settles by hand — ask us.
        </li>
        <li>
          <b>Not audited.</b> Testnet software, testnet funds, no external review. We ran an
          adversarial self-audit on Aug 1 and fixed what it found; that is not the same thing as an
          audit.
        </li>
      </ul>
    </div>
  );
}
