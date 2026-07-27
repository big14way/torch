import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

/** Dependency-free pushState router. vercel.json already rewrites every path
 * to index.html, so clean URLs (/trade, /league, /verify) work when shared. */

const Ctx = createContext<{ path: string; navigate: (to: string) => void }>({
  path: "/",
  navigate: () => {},
});

export function Router({ children }: { children: ReactNode }) {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = (to: string) => {
    if (to !== window.location.pathname) {
      window.history.pushState(null, "", to);
      setPath(to);
      window.scrollTo(0, 0);
    }
  };
  return <Ctx.Provider value={{ path, navigate }}>{children}</Ctx.Provider>;
}

export const useRoute = () => useContext(Ctx);

/** Real <a> so cmd-click / middle-click / copy-link all behave. */
export function Link({
  to,
  className,
  children,
}: {
  to: string;
  className?: string;
  children: ReactNode;
}) {
  const { path, navigate } = useRoute();
  return (
    <a
      href={to}
      className={className}
      aria-current={path === to ? "page" : undefined}
      onClick={(e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
          return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}
