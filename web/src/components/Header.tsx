import { useEffect, useRef, useState } from "react";
import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { ACTIVE_CHAIN, DEPLOY, FEEDBACK_CONFIGURED, feedbackUrl } from "../lib/config";
import { fmtPx, useXrpPrice } from "../lib/hooks";

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

export default function Header({
  marketKey,
  mark,
  onHow,
}: {
  marketKey: string;
  mark: bigint | undefined;
  onHow: () => void;
}) {
  // useAccount().chainId reflects the wallet's actual chain; wagmi's useChainId()
  // only ever returns the configured chain in a single-chain setup, so it can
  // never detect a wallet sitting on the wrong network.
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  const { data: xrpPx } = useXrpPrice();

  const wrongNet = isConnected && chainId !== ACTIVE_CHAIN.id;

  return (
    <header className="header">
      <div className="wordmark">
        <Flame />
        <h1>TORCH</h1>
        <span className="tagline">XRP margin in. Hyperliquid depth out.</span>
      </div>

      <div className="statstrip" aria-live="polite">
        <div className="stat">
          <span className="label">XRP / USD</span>
          <TickValue value={xrpPx as bigint | undefined} />
        </div>
        <div className="stat">
          <span className="label">{marketKey} mark</span>
          <TickValue value={mark} />
        </div>
        <div className="stat">
          <span className="label">Network</span>
          <span className="value">{DEPLOY.mode === "local" ? "Localhost" : "Coston2"}</span>
        </div>
      </div>

      <div className="spacer" />

      <button className="btn ghost sm" onClick={onHow}>How it works</button>
      {FEEDBACK_CONFIGURED && (
        <a className="btn ghost sm" href={feedbackUrl(address)} target="_blank" rel="noreferrer">
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
      ) : (
        <button
          className="btn primary"
          disabled={isPending || connectors.length === 0}
          onClick={() => connect({ connector: connectors[0] })}
        >
          {isPending ? "Connecting..." : "Connect wallet"}
        </button>
      )}
    </header>
  );
}
