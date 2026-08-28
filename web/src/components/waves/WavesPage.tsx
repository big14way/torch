import { useCallback, useEffect, useMemo, useState } from "react";
import { WAVES, isXrplAddress, shortAddr } from "../../lib/waves/config";
import { flareAddressFor } from "../../lib/waves/fsa";
import { connect, disconnect, listWallets, useWavesWallet, type WalletChoice } from "../../lib/waves/wallet";
import { readWall, type Wall } from "../../lib/waves/ledger";
import { join, JoinError, type JoinResult } from "../../lib/waves/pay";
import { Link } from "../../lib/router";

/** Make Waves. The only page on Torch that touches the real XRP Ledger.
 *
 * Structure follows the order a sceptical person actually reads in: what this
 * is, something true about their own wallet given for free, why Torch exists,
 * what they get, then the full disclosure, and only then the ask. The payment
 * button is deliberately the last thing on the page.
 */
export default function WavesPage() {
  const wallet = useWavesWallet();
  const referrer = useMemo(() => {
    try {
      const v = new URLSearchParams(location.search).get("from");
      return v && isXrplAddress(v) ? v : undefined;
    } catch {
      return undefined;
    }
  }, []);

  return (
    <main className="page-narrow">
      <div className="pagehero">
        <div className="ph-eyebrow">Make Waves · XRP Ledger</div>
        <h2 className="ph-title">
          Say count me in, <span className="ph-grad">in a way nobody can fake.</span>
        </h2>
        <p className="ph-sub">
          Torch is a trading terminal for XRP holders, built so you can check every number yourself
          instead of trusting a dashboard. This page is how you join it early. You connect an XRP
          wallet, send one payment of {WAVES.joinXrp} XRP, and your address goes on a public list
          that we cannot pad, because every entry on it is a signature you made and anyone can go
          and read.
        </p>
        {referrer && (
          <p className="ph-sub">
            <b>{shortAddr(referrer)}</b> passed you the torch. They get the credit when you join.
          </p>
        )}
      </div>

      <Counter />
      <FlareReveal />
      <WhatYouGet />
      <TrustAndSafety />
      <JoinCard referrer={referrer} wallet={wallet} />
      <WallOfWaves />
    </main>
  );
}

/* ------------------------------------------------------------------ counter */

function Counter() {
  const [wall, setWall] = useState<Wall | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let dead = false;
    readWall()
      .then((w) => !dead && setWall(w))
      .catch(() => !dead && setFailed(true));
    return () => {
      dead = true;
    };
  }, []);

  const n = wall?.distinct ?? 0;
  const pct = Math.min(100, (n / WAVES.target) * 100);

  return (
    <div className="card waves-counter">
      <div className="wc-head">
        <b>{failed ? "?" : wall ? n : "..."}</b>
        <span>
          of {WAVES.target} XRP Ledger accounts. This is the number the hackathon counts, and the
          only one we are tracking.
        </span>
      </div>
      <div className="wc-bar" aria-hidden="true">
        <div className="wc-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="wc-note">
        Counted from the ledger itself, not from our records: distinct addresses that sent a
        successful payment carrying tag {WAVES.sourceTag} to{" "}
        <a
          href={`https://xrpscan.com/account/${WAVES.treasury}`}
          target="_blank"
          rel="noreferrer"
        >
          our treasury
        </a>
        . Counting closes 21 September 2026.
        {failed && " We could not reach the ledger just now, so this reads blank rather than guessing."}
      </div>
    </div>
  );
}

/* ------------------------------------------------------- free Flare reveal */

function FlareReveal() {
  const [input, setInput] = useState("");
  const [result, setResult] = useState<{ r: string; flare: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const look = async () => {
    setErr(null);
    setBusy(true);
    try {
      const flare = await flareAddressFor(input);
      setResult({ r: input.trim(), flare });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not look that up.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card waves-reveal">
      <h2>SOMETHING TRUE ABOUT YOUR WALLET, FREE</h2>
      <p>
        Your XRP wallet already controls an address on Flare. You never created it, you do not need
        a second wallet for it, and it exists whether or not you ever use it. Paste any XRP address
        and see. This costs nothing, signs nothing, and sends nothing.
      </p>
      <div className="inline-amount">
        <input
          aria-label="Your XRP address"
          type="text"
          value={input}
          placeholder="r..."
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && isXrplAddress(input) && look()}
        />
        <button className="btn" disabled={!isXrplAddress(input) || busy} onClick={look}>
          {busy ? "Looking..." : "Show me"}
        </button>
      </div>
      {err && <div className="notice error">{err}</div>}
      {result && (
        <div className="waves-reveal-out">
          <div className="row">
            <span>Your XRP address</span>
            <b>{shortAddr(result.r, 10)}</b>
          </div>
          <div className="row">
            <span>controls, on Flare</span>
            <b>
              <a
                href={`https://flare-explorer.flare.network/address/${result.flare}`}
                target="_blank"
                rel="noreferrer"
              >
                {result.flare}
              </a>
            </b>
          </div>
          <p className="waves-reveal-note">
            That is Flare's own Smart Accounts feature, not something Torch made up. It is why
            Torch can take XRP as margin without asking you to bridge anything or learn a new
            wallet, and it is the direction this whole product is going.
          </p>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- what you get */

function WhatYouGet() {
  return (
    <div className="card">
      <h2>WHAT JOINING GETS YOU</h2>
      <div className="ld-features">
        <div className="ld-feat">
          <div className="ld-feat-t">First in when Torch takes real money</div>
          <div className="ld-feat-d">
            Torch trades on a test network today. When it opens on real funds, the addresses on
            this list are the first ones let in. You are identified by the address that signed and
            by nothing else. No email, no name, no form.
          </div>
        </div>
        <div className="ld-feat">
          <div className="ld-feat-t">A place on a list we cannot edit</div>
          <div className="ld-feat-d">
            Your address and a link to the payment you signed. The list is built from the ledger,
            so we cannot add a name that never signed or quietly remove one that did. If you ever
            want to check whether Torch inflates its own numbers, this is the number to audit.
          </div>
        </div>
        <div className="ld-feat">
          <div className="ld-feat-t">A torch to pass</div>
          <div className="ld-feat-d">
            Once you have joined you get a link with your address in it. Anyone who joins through
            it is credited to you on the list. It is an ordinary share link, not another payment,
            so passing it on costs you nothing.
          </div>
        </div>
      </div>
      <p className="waves-anti">
        <b>What you do not get:</b> no token, no allocation, no share of anything, no return of any
        kind, and no claim on the {WAVES.joinXrp} XRP once it is sent. If you are here for an
        airdrop this is the wrong page, and we would rather say so than take your XRP.
      </p>
    </div>
  );
}

/* ---------------------------------------------------------- trust & safety */

function TrustAndSafety() {
  return (
    <div className="card verify-card">
      <h2>READ THIS BEFORE YOU SEND ANYTHING</h2>
      <p>
        You are about to send real money to a stranger on the internet. Most projects write this
        part in legal language and bury it. We would rather over-explain. If any line here bothers
        you, do not send the payment. The free test-network terminal is open either way, and that
        does not expire.
      </p>
      <ul className="verify-links">
        <li>
          <b>Torch's trading runs on a test network with practice funds. This payment is real.</b>{" "}
          That tension is the honest headline, so here it is up front rather than in a footnote.
          You are not buying a product; you are putting your name on a list early, on the one chain
          where a name can be proven. If that trade does not appeal, do not make it.
        </li>
        <li>
          <b>Exactly what the payment is.</b> One payment of {WAVES.joinXrp} XRP from your address
          to{" "}
          <a href={`https://xrpscan.com/account/${WAVES.treasury}`} target="_blank" rel="noreferrer">
            {WAVES.treasury}
          </a>
          , plus the ledger's own fee of a small fraction of a cent, which goes to the network and
          not to us. It carries a note reading <code>{WAVES.memo}</code> and the number{" "}
          <code>{WAVES.sourceTag}</code>. That is the entire transaction. There is nothing else in
          it. The amount is fixed, and sending more buys nothing.
        </li>
        <li>
          <b>Why that number is on it.</b> {WAVES.sourceTag} is a source tag, a label a sender can
          attach to a payment to record where it came from. XRPL Commons gave it to Torch when we
          were accepted into their Make Waves programme, and they count how many different accounts
          send a payment carrying it. So it is a tracking number, it benefits us, and we are
          telling you rather than letting you find it yourself. That is the deal on this whole
          site.
        </li>
        <li>
          <b>Torch never touches your keys, and cannot take anything later.</b> There is no field
          here that asks for a seed phrase and no reason for one to exist. Anything claiming to be
          Torch that asks for a seed phrase is trying to rob you. The XRP Ledger also has no
          unlimited spending approval, so there is nothing to grant and nothing to revoke: your
          wallet signs one payment for one amount, once. If you are prompted a second time on this
          page, refuse it and tell us.
        </li>
        <li>
          <b>What we cannot promise.</b> No date for real-money trading. Torch has not been
          audited. Early access means early access, with tight caps, and nothing more. We could
          also simply fail to reach 300 accounts and win nothing, in which case you have spent{" "}
          {WAVES.joinXrp} XRP to be on a list. That is the realistic downside and you should price
          it in.
        </li>
      </ul>
      <p>
        Everything else Torch cannot prove is written down on the{" "}
        <Link to="/verify">Verify page</Link>, in a section that exists specifically to say so.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------- joining */

type Phase = "idle" | "picking" | "connecting" | "ready" | "signing" | "done";

function JoinCard({ referrer, wallet }: { referrer?: string; wallet: ReturnType<typeof useWavesWallet> }) {
  const [phase, setPhase] = useState<Phase>(wallet ? "ready" : "idle");
  const [wallets, setWallets] = useState<WalletChoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<JoinResult | null>(null);

  useEffect(() => {
    if (wallet && phase === "idle") setPhase("ready");
  }, [wallet, phase]);

  const openPicker = useCallback(async () => {
    setError(null);
    setPhase("picking");
    try {
      setWallets(await listWallets());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load wallets.");
      setPhase("idle");
    }
  }, []);

  const pick = async (id: string) => {
    setError(null);
    setPhase("connecting");
    try {
      await connect(id);
      setPhase("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not connect.");
      setPhase("picking");
    }
  };

  const send = async () => {
    if (!wallet) return;
    setError(null);
    setPhase("signing");
    try {
      const r = await join(wallet.address, referrer);
      setResult(r);
      setPhase("done");
    } catch (e) {
      setError(e instanceof JoinError ? e.message : "Something went wrong.");
      setPhase("ready");
    }
  };

  if (phase === "done" && result) return <Joined result={result} address={wallet?.address ?? ""} />;

  return (
    <div className="card waves-join">
      <h2>JOIN</h2>

      {!wallet ? (
        <>
          <p>
            One wallet connection, then one payment of {WAVES.joinXrp} XRP. Connecting only shows
            us your public address. It does not move anything.
          </p>
          {phase !== "picking" && phase !== "connecting" ? (
            <button className="btn primary wide" onClick={openPicker}>
              Connect your XRP wallet
            </button>
          ) : (
            <div className="waves-wallets">
              {wallets === null ? (
                <span className="hint">Looking for wallets...</span>
              ) : (
                wallets.map((w) => (
                  <button
                    key={w.id}
                    className={`btn ${w.available ? "" : "ghost"}`}
                    disabled={!w.available || phase === "connecting"}
                    onClick={() => pick(w.id)}
                    title={w.available ? `Connect ${w.name}` : `${w.name} is not installed here`}
                  >
                    {w.name}
                    {!w.available && w.url && (
                      <a href={w.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                        {" "}
                        install
                      </a>
                    )}
                  </button>
                ))
              )}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="balrow">
            <span className="k">Connected with {wallet.walletName}</span>
            <span className="v">{shortAddr(wallet.address, 8)}</span>
          </div>
          <p>
            Sending {WAVES.joinXrp} XRP to {shortAddr(WAVES.treasury, 8)}, tagged{" "}
            {WAVES.sourceTag}. Your wallet will show you the whole transaction before you approve
            it. Read it there, not here.
          </p>
          <button className="btn primary wide" disabled={phase === "signing"} onClick={send}>
            {phase === "signing" ? "Confirm in your wallet..." : `Send ${WAVES.joinXrp} XRP and join`}
          </button>
          <button className="btn ghost sm" onClick={() => void disconnect()}>
            Disconnect
          </button>
        </>
      )}

      {error && <div className="notice error">{error}</div>}
    </div>
  );
}

function Joined({ result, address }: { result: JoinResult; address: string }) {
  const share = `${location.origin}/waves?from=${address}`;
  const tagMissing = result.check !== null && result.check.sourceTag !== WAVES.sourceTag;

  return (
    <div className="card waves-join">
      <h2>YOU ARE ON THE LIST</h2>
      <p>
        Your payment is on the ledger.{" "}
        <a href={`https://xrpscan.com/tx/${result.hash}`} target="_blank" rel="noreferrer">
          Go and read it
        </a>
        . We did not write anything down that you cannot check yourself.
      </p>

      {tagMissing && (
        <div className="notice error">
          Your payment went through, but your wallet did not keep the tag on it, so it will not
          count toward the 300. That is our problem to fix, not yours, and we would rather tell you
          than quietly count you. Please let us know which wallet you used.
        </div>
      )}
      {result.check === null && (
        <div className="notice">
          The payment was accepted. We could not re-read it from the ledger just now, so check the
          link above in a minute to see it confirmed.
        </div>
      )}

      <p>
        <b>Pass the torch.</b> Anyone who joins through this link is credited to you. It is an
        ordinary link, so sharing it costs nothing.
      </p>
      <div className="inline-amount">
        <input readOnly value={share} aria-label="Your share link" onFocus={(e) => e.currentTarget.select()} />
        <button className="btn" onClick={() => void navigator.clipboard?.writeText(share)}>
          Copy
        </button>
      </div>

      <p>
        Next: the terminal is open now, free, on a test network.{" "}
        <Link to="/trade">Go and break it</Link>, then tell us what was confusing. That feedback is
        worth more to us than the payment was.
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------- the wall */

function WallOfWaves() {
  const [wall, setWall] = useState<Wall | null>(null);

  useEffect(() => {
    let dead = false;
    readWall()
      .then((w) => !dead && setWall(w))
      .catch(() => undefined);
    return () => {
      dead = true;
    };
  }, []);

  if (!wall || wall.addresses.length === 0) return null;

  return (
    <div className="card">
      <h2>THE WALL</h2>
      <p>
        Everyone who has joined, in the order the ledger recorded them. Built from the chain, so it
        is the same list anyone else would get.
      </p>
      <div className="waves-wall">
        {wall.addresses.map((a, i) => (
          <a key={a} href={`https://xrpscan.com/account/${a}`} target="_blank" rel="noreferrer">
            <span className="ww-n">{i + 1}</span>
            {shortAddr(a)}
          </a>
        ))}
      </div>
      {wall.truncated && <div className="wc-note">Showing the first {wall.addresses.length}.</div>}
    </div>
  );
}
