import { useState } from "react";
import { useAccount } from "wagmi";
import { FEEDBACK_CONFIGURED, feedbackUrl, type Position } from "../lib/config";

const KEY = "torch_feedback_dismissed";

/** After a tester closes a trade, gently ask for feedback — the moment they
 * have the most to say. Dismissal is remembered so it never nags. */
export default function FeedbackNudge({ positions }: { positions: Position[] | undefined }) {
  const { address } = useAccount();
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(KEY) === "1";
    } catch {
      return false;
    }
  });

  if (!FEEDBACK_CONFIGURED || dismissed) return null;
  const hasClosed = (positions ?? []).some((p) => p.status === 4 || p.status === 5);
  if (!hasClosed) return null;

  const close = () => {
    try {
      localStorage.setItem(KEY, "1");
    } catch {
      /* ignore */
    }
    setDismissed(true);
  };

  return (
    <div className="fb-nudge">
      <span>
        You ran a trade on Torch. How did it go? <b>60 seconds</b> of feedback genuinely shapes
        what ships next, and links your wallet for the league.
      </span>
      <span className="fb-actions">
        <a
          className="btn sm primary"
          href={feedbackUrl(address)}
          target="_blank"
          rel="noreferrer"
          onClick={close}
        >
          Give feedback
        </a>
        <button className="btn sm ghost" onClick={close}>
          Later
        </button>
      </span>
    </div>
  );
}
