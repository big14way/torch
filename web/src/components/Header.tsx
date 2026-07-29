import { useEffect, useRef, useState } from "react";
import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { ACTIVE_CHAIN, DEPLOY, FEEDBACK_CONFIGURED, feedbackUrl } from "../lib/config";
import { fmtPx, useXrpPrice } from "../lib/hooks";
import { stopWatching, useWatch, watchAccount } from "../lib/watch";
import { Link } from "../lib/router";

function Flame() {
  return (
    <svg width="22" height="26" viewBox="0 0 22 26" aria-hidden="true">
      <path
        d="M11 0C13 5 18 7 18 14a7 7 0 1 1-14 0c0-3 1.4-5 3-7 .4 2 1.2 3.2 2.5 4C9 7 9.5 3.5 11 0Z"
        fill="url(#g)"
      />
      <defs>
        <linearGradient id="g" x1="4" y1="26" x2="18" y2="2">
          <stop offset="0" stopColor="#ff6a2b" />
          <stop offset="1" stopColor="#ffc24b" />
        </linearGradient>
      </defs>
    </svg>
  );
}

function TickValue({ value }: { value: bigint | undefined }) {
  const prev = useRef<bigint | undefined>(undefined);
  const [cls, setCls] = useState("");
  useEffect(() => {
    if (value !== undefined && prev.current !== undefined && value !== prev.current) {
      setCls(value > prev.current ? "tick-up" : "tick-down");
      const t = setTimeout(() => setCls(""), 700);
      prev.current = value;
      return () => clearTimeout(t);
    }
    prev.current = value;
  }, [value]);
  return <span className={`value ${cls}`}>{value !== undefined ? `$${fmtPx(value)}` : "..."}</span>;
}

export default function Header() {
  // useAccount().chainId reflects the wallet's actual chain; wagmi's useChainId()
  // only ever returns the configured chain in a single-chain setup, so it can
  // never detect a wallet sitting on the wrong network.
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  const { data: xrpPx } = useXrpPrice();

  const wrongNet = isConnected && chainId !== ACTIVE_CHAIN.id;
  const [pickerOpen, setPickerOpen] = useState(false);
  const watch = useWatch();

  // XRPL users (Flare Smart Accounts) have no EVM key to sign with, but their
  // account is plain vault state under a derivable address — offer view access.
  const [xrplForm, setXrplForm] = useState(false);
  const [xrplInput, setXrplInput] = useState("");
  const [xrplBusy, setXrplBusy] = useState(false);
  const [xrplErr, setXrplErr] = useState<string | null>(null);
  const xrplOption = DEPLOY.mode === "coston2";
  const closePicker = () => {
    setPickerOpen(false);
    setXrplForm(false);
    setXrplErr(null);
  };
  const submitXrpl = async () => {
    setXrplBusy(true);
    setXrplErr(null);
    try {
      await watchAccount(xrplInput);
      setXrplInput("");
      closePicker();
    } catch (e) {
      setXrplErr(e instanceof Error ? e.message : String(e));
    } finally {
      setXrplBusy(false);
    }
  };

  // Mobile browsers have no injected provider (that only exists on desktop
  // extensions and inside wallet in-app browsers). When both the extension and
  // WalletConnect are available, offer the choice — auto-grabbing the extension
  // hijacks users who wanted a different wallet. With a single option, connect
  // straight through; with none, deep-link into MetaMask's in-app browser.
  const eth =
    typeof window !== "undefined"
      ? (window as { ethereum?: { isMetaMask?: boolean } }).ethereum
      : undefined;
  const hasInjected = !!eth;
  const wcConnector = connectors.find((c) => c.id === "walletConnect");
  const injectedConnector = connectors.find((c) => c.id === "injected");
  const choices = [
    ...(hasInjected && injectedConnector
      ? [
          {
            connector: injectedConnector,
            label: eth?.isMetaMask ? "MetaMask" : "Browser wallet",
            hint: "extension in this browser",
          },
        ]
      : []),
    ...(wcConnector
      ? [{ connector: wcConnector, label: "WalletConnect", hint: "QR code / mobile wallets" }]
      : []),
  ];
  const pick = (connector: (typeof connectors)[number]) => {
    closePicker();
    connect({ connector });
  };
  const menuNeeded = choices.length + (xrplOption ? 1 : 0) > 1;
  const metamaskDeepLink =
    typeof window !== "undefined"
      ? `https://metamask.app.link/dapp/${window.location.host}${window.location.pathname}`
      : "https://metamask.app.link/dapp/usetorch.xyz";

  return (
    <header className="header">
      <Link to="/" className="wordmark">
        <Flame />
        <h1>TORCH</h1>
      </Link>

      <nav className="mainnav" aria-label="Main">
        <Link to="/trade">Trade</Link>
        <Link to="/league">League</Link>
        <Link to="/verify">Verify</Link>
      </nav>

      <div className="spacer" />

      <div className="statstrip" aria-live="polite">
        <div className="stat">
          <span className="label">XRP / USD</span>
          <TickValue value={xrpPx as bigint | undefined} />
        </div>
        <div className="stat">
          <span className="label">Network</span>
          <span className="value">{DEPLOY.mode === "local" ? "Localhost" : "Coston2"}</span>
        </div>
      </div>

      {FEEDBACK_CONFIGURED && (
        <a className="btn ghost sm hide-sm" href={feedbackUrl(address)} target="_blank" rel="noreferrer">
          Feedback
        </a>
      )}

      {wrongNet ? (
        <button className="btn primary" onClick={() => switchChain({ chainId: ACTIVE_CHAIN.id })}>
          Switch to {ACTIVE_CHAIN.name}
        </button>
      ) : isConnected ? (
        <>
          <span className="pill">
            <span className="dot" />
            {address?.slice(0, 6)}...{address?.slice(-4)}
          </span>
          <button className="btn ghost sm" onClick={() => disconnect()}>
            Disconnect
          </button>
        </>
      ) : menuNeeded ? (
        <>
          {watch && (
            <>
              <span className="pill" title={watch.rAddress ?? watch.address}>
                <span className="dot watch" />
                {(watch.rAddress ?? watch.address).slice(0, 6)}...
                {(watch.rAddress ?? watch.address).slice(-4)} view
              </span>
              <button className="btn ghost sm" onClick={stopWatching}>
                Stop
              </button>
            </>
          )}
          <div className="wallet-pick">
            <button
              className="btn primary"
              disabled={isPending}
              aria-expanded={pickerOpen}
              onClick={() => (pickerOpen ? closePicker() : setPickerOpen(true))}
            >
              {isPending ? "Connecting..." : "Connect wallet"}
            </button>
            {pickerOpen && (
              <>
                <div className="wallet-backdrop" onClick={closePicker} />
                <div className="wallet-menu" role="menu">
                  {!xrplForm ? (
                    <>
                      {choices.map((c) => (
                        <button key={c.connector.uid} role="menuitem" onClick={() => pick(c.connector)}>
                          {c.label}
                          <span>{c.hint}</span>
                        </button>
                      ))}
                      {xrplOption && (
                        <button role="menuitem" onClick={() => setXrplForm(true)}>
                          XRP Ledger wallet
                          <span>view your Flare Smart Account, read-only</span>
                        </button>
                      )}
                    </>
                  ) : (
                    <div className="wallet-xrpl">
                      <input
                        aria-label="XRPL or 0x address"
                        placeholder="rXXXX... or 0x..."
                        value={xrplInput}
                        autoFocus
                        onChange={(e) => setXrplInput(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && !xrplBusy && submitXrpl()}
                      />
                      <button className="btn primary sm" disabled={xrplBusy || !xrplInput.trim()} onClick={submitXrpl}>
                        {xrplBusy ? "Deriving..." : "View account"}
                      </button>
                      {xrplErr && <div className="wallet-xrpl-err">{xrplErr}</div>}
                      <div className="wallet-xrpl-hint">
                        Your XRPL address maps to a Flare Smart Account. Viewing is instant;
                        funding it happens from your XRPL wallet.
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </>
      ) : choices.length === 1 ? (
        <button
          className="btn primary"
          disabled={isPending}
          onClick={() => pick(choices[0].connector)}
        >
          {isPending ? "Connecting..." : "Connect wallet"}
        </button>
      ) : (
        <a className="btn primary" href={metamaskDeepLink} style={{ textAlign: "center" }}>
          Open in MetaMask
        </a>
      )}
    </header>
  );
}
