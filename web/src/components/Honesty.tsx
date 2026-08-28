import { useReadContract } from "wagmi";
import { VAULT } from "../lib/config";
import { fmtFxrp, useExecutorStatus } from "../lib/hooks";

/**
 * The counterweight to every claim on this page. A verification page that only
 * lists what we can prove is marketing; the useful half is the part that says
 * what is not proven yet. Written after an adversarial audit of our own code
 * (Aug 1) and kept current as things change: stop-loss orders, automatic
 * receipts, payout caps and the move off sealed hosting each added a
 * limitation worth naming, and a limitations list that lags the product is
 * worse than none.
 *
 * Plain words, exact facts. Two values are read live rather than typed: the
 * execution mode comes from the trading service's own status page and the
 * insurance fund from the vault, so neither can drift out of date the way
 * hand-written copy does.
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
            <>
              We cannot reach the trading service right now, so assume the exchange leg is not
              running.
            </>
          ) : routesToExchange ? (
            <>
              Running in <b>{mode}</b> mode: markets the exchange lists go to a real order book,
              and XRP does not. That is a status line, not a proof. Everything below is what it
              still does not buy you.
            </>
          ) : (
            <>
              Running in <b>mock</b> mode: orders fill at the price Flare publishes and{" "}
              <b>nothing reaches an exchange right now</b>. The exchange leg has been proven
              separately on the test network, and switching to it is a setting, not new code.
            </>
          )}
        </span>
      </div>

      <ul className="verify-links">
        <li>
          <b>The part that sends transactions runs on ordinary hosting.</b> Until August it ran in
          sealed hardware, back when whoever held that key could still choose your entry price.
          That is no longer true: the price is signed inside Flare's confidential compute and the
          vault refuses anything unsigned, so sealing the sender stopped buying you a guarantee and
          started costing reliability instead. What is left is a service that pays fees and presses
          send. It cannot choose your price, cannot withdraw, and cannot move your funds. It can
          still go down, and the two escape hatches below are what cover you when it does.
        </li>
        <li>
          <b>Your stop is an instruction to us, not a guarantee.</b> Only our service can fire a
          stop-loss or take-profit. The contract makes it re-read the price feed and refuses a
          trigger that has not actually been crossed, so it cannot fire one early, but there is no
          button that lets you fire your own. If our service is down your stop does not fire, and
          nothing starts a clock for you: you request a close and wait it out like any other exit.
          A position with a close already pending has its stop switched off until you retract it.
          And when a trigger does fire it settles at the feed price at that moment, not the number
          you typed. A price that jumps straight past your stop settles past your stop, on purpose,
          because pinning it to your exact number would make a position impossible to close exactly
          when the stop matters most.
        </li>
        <li>
          <b>Winnings are capped at the insurance fund.</b> Profit is paid out of a fund you can
          see on-chain
          {insurance !== undefined ? <>, currently {fmtFxrp(insurance)} FXRP</> : null}, and a win
          bigger than that balance pays out the balance. The vault records that it capped you, and
          your settled row shows what was actually paid next to the full amount. On the test
          network the fund is deliberately small and shrinks as winners draw on it, so the order
          ticket warns you before you size into the cap rather than after.
        </li>
        <li>
          <b>The receipt proves a trade exists, not that it matches your position.</b> Flare's
          validators go back to the exchange and prove on-chain that the order number our vault
          recorded really is there, on the right market and the right side. They do not compare its
          price, its size or its timing to your position. It proves the two things co-exist, not
          that one caused the other. It also covers the <b>opening</b> trade only: the closing one,
          which is what actually sets your profit or loss, has no exchange order number attached
          and cannot be re-checked this way at all.
        </li>
        <li>
          <b>Your entry price is signed. Your exit price is not.</b> Since Aug 12 the vault will
          not accept an entry price without a signature from a sealed machine Flare currently
          vouches for (extension 66154, checked against Flare's own register on every call), so we
          can send the transaction but cannot choose the number in it. That covers the entry only.
          Your exit is still a price we report. It has to sit inside the band around Flare's feed
          and can never be worse for you than the feed, but nothing signs it.
        </li>
        <li>
          <b>Exchange routing will not cover every market.</b> The test exchange does not list XRP.
          Even with the exchange leg switched on, XRP trades fill at the price Flare publishes,
          with no exchange order behind them, nothing hedged, and nothing for the validators to
          re-check. Only the listed markets (BTC, ETH and others) carry a real order number and can
          earn a receipt.
        </li>
        <li>
          <b>We still have room to move inside the band.</b> We cannot invent a price: every
          settlement has to land within 1.5% of Flare's feed, and the live vault also refuses any
          price worse for you than the feed itself. Inside that band, we choose. If we stall, a
          close you already requested is never stuck: retract it for free at any time, or two hours
          after you asked, answered or not, settle it yourself at the live feed price with nobody
          from Torch involved. That two-hour escape covers a requested close only. An untouched
          stop has no such timer, as above. One more edge worth naming: a position with a pending
          close is still marked against the market and can be closed out for low margin before it
          settles.
        </li>
        <li>
          <b>The owner key is a real thing you are trusting.</b> One address can repoint the price
          feed and the service, change the caps and the parameters, and withdraw from the insurance
          fund. There is no delay on any of it yet. On a test network that is a deliberate trade
          for speed, and it has to change before real money.
        </li>
        <li>
          <b>The old vault is still out there.</b> Torch moved to a new vault on Aug 6. The old one
          keeps its full trading history on-chain and still holds a few open positions, but it has
          no self-close, its price checking is weaker, and this app does not talk to it. If you
          traded there and still have a position open, it settles by hand, so ask us.
        </li>
        <li>
          <b>Not audited.</b> Test network, practice funds, no outside review. We ran an
          adversarial audit against our own code on Aug 1 and fixed what it found. That is not the
          same thing as an audit.
        </li>
      </ul>
    </div>
  );
}
