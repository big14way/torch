import { useExecutorStatus } from "../lib/hooks";

/**
 * The counterweight to every claim on this page. A verification page that only
 * lists what we can prove is marketing; the useful half is the part that says
 * what is not proven yet. Written after an adversarial audit of our own code
 * (Aug 1) turned up three public claims stronger than the implementation.
 *
 * The execution mode is read live from the enclave's own status endpoint, so
 * this section cannot drift out of date the way hand-written copy does.
 */
export default function Honesty() {
  const { status, routesToExchange } = useExecutorStatus();
  const mode = status?.executionMode;

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
            Execution mode <b>{mode}</b>: fills are placed on the exchange book.
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
          <b>The attestation proves a fill exists, not that it matches your position.</b> Flare's
          validators re-fetch the exchange and prove on-chain that the order id the vault recorded
          really exists in our account with the right market and side. They do not compare its
          price, its size, or its timestamp to the position. It proves co-existence, not causation.
        </li>
        <li>
          <b>Attestation does not gate settlement.</b> It is an after-the-fact receipt anyone can
          reproduce, not a precondition. No vault code path reads it, so an unattested position
          settles exactly like an attested one.
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
          settlement must sit within 1.5% of the oracle, and as of the v2 vault it may never be
          worse for you than the oracle itself. Within that, it chooses. It can also stall: if the
          agent stops, a close you requested waits — but never indefinitely. You can retract a
          pending close for free at any time, and two hours after you asked — answered or not —
          the Self-close button settles you at the live oracle price, no executor needed. One more
          edge worth naming: a position with a pending close is still marked to market and can be
          liquidated until it actually settles.
        </li>
        <li>
          <b>The owner key is a real trust assumption.</b> One address can repoint the oracle and
          the executor. There is no timelock yet. On testnet that is a deliberate tradeoff for
          iteration speed; it must change before real money.
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
