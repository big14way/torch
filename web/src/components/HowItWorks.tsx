import { FDC } from "../lib/config";

/** The five-step trust walk. Rendered at the top of the /verify page.
 *
 * This page is the one place that keeps the exact names and addresses, because
 * it exists for the reader who wants to go and check. The rule here is plain
 * English first, precise name in brackets after, so a newcomer is never asked
 * to learn a protocol acronym in order to follow the sentence. */
export function HowItWorksContent() {
  // Link the CURRENT receipt, not a hardcoded one: a consumer redeploy moved
  // these once already and left the page pointing at a retired contract.
  const receiptTx = FDC.positionAttest?.tx ?? FDC.attestTx;
  return (
    <div className="howworks">
      <ol>
        <li>
          Put XRP into the Torch vault on Flare, as FXRP. Your margin never leaves the chain.
        </li>
        <li>Open a long or short. The vault locks your margin and announces the order.</li>
        <li>
          Torch's service places a matching order on Hyperliquid, for the markets that exchange
          lists. XRP is not one of them yet, so those fill at the price Flare publishes instead.
          The key used at the exchange can trade but cannot withdraw, so it never takes custody of
          anything.
        </li>
        <li>
          The price that comes back has to sit inside a tight band around the price Flare itself
          publishes (its FTSOv2 feed). The contract rejects anything outside that band, and
          anything worse for you than the feed.
        </li>
        <li>
          Close whenever you like. Profit and loss settle in FXRP on Flare: wins are paid out of
          an insurance fund, losses are paid into it.
        </li>
      </ol>
      <p>
        The honest version of the trust model: you are trusting an operator you can check, rather
        than a black box. Two separate things do that checking.
      </p>
      <p>
        <b>Your entry price is not ours to choose.</b> It is read from the exchange and signed
        inside Flare's own confidential compute, a sealed machine registered on Coston2 as
        extension 66154. The vault will not accept an entry price without a signature from a
        machine that Flare's validators currently vouch for, and it checks that against Flare's
        own register on every single call. Torch's service pays the fee and picks the moment. It
        cannot pick the number. And if the price Flare published was kinder to you than the
        exchange fill, the contract moves your entry to the kinder one.
      </p>
      <p>
        <b>Afterwards, the trade is re-checked by people who are not us.</b> Flare's validators go
        back to the exchange, read the order again, and record on-chain that it really existed with
        the right market and side
        {receiptTx ? (
          <>
            ,{" "}
            <a
              href={`https://coston2-explorer.flare.network/tx/${receiptTx}`}
              target="_blank"
              rel="noreferrer"
            >
              like this one
            </a>
          </>
        ) : null}
        . Be clear about what that is: a receipt, not a gate. No part of the vault reads it, and
        what it does not cover is listed below.
      </p>
    </div>
  );
}
