import { useCallback, useEffect, useState } from "react";
import { ApiError, api, setTokenGetter } from "./lib/api";
import { getIdToken, initAuth, isLoggedIn, logout } from "./lib/auth";
import type { AppConfig, MeResponse, User, VaultResponse } from "./lib/types";
import Landing from "./screens/Landing";
import Setup from "./screens/Setup";
import Dashboard from "./screens/Dashboard";
import TopBar from "./components/TopBar";
import { Button, ErrorNote } from "./components/ui";
import { isOnboarded } from "./lib/vault";

type View =
  | { name: "boot" }
  | { name: "error"; message: string }
  | { name: "landing"; notice?: string }
  | { name: "setup"; me: MeResponse }
  | { name: "dashboard"; user: User; vault: VaultResponse };

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [view, setView] = useState<View>({ name: "boot" });

  const route = useCallback(async () => {
    try {
      if (!(await isLoggedIn())) {
        setView({ name: "landing" });
        return;
      }
      const me = await api.me();
      if (me.needsSetup) {
        setView({ name: "setup", me });
        return;
      }
      const data = await api.vault();
      if (isOnboarded(data.vault, me.user)) {
        setView({ name: "dashboard", user: me.user, vault: data });
      } else {
        setView({ name: "setup", me });
      }
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        setView({ name: "landing", notice: "Your session ended. Sign in again to continue." });
        return;
      }
      setView({
        name: "error",
        message: reason instanceof Error ? reason.message : String(reason),
      });
    }
  }, []);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const appConfig = await api.config();
        if (!live) return;
        setConfig(appConfig);
        initAuth(appConfig);
        setTokenGetter(getIdToken);
        await route();
      } catch (reason) {
        if (live) {
          setView({
            name: "error",
            message:
              reason instanceof Error
                ? reason.message
                : "The app server is not answering. Start it, then reload.",
          });
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [route]);

  async function onSignOut() {
    try {
      await logout();
    } finally {
      setView({ name: "landing" });
    }
  }

  if (view.name === "boot" || (view.name !== "error" && !config)) {
    return (
      <>
        <TopBar />
        <main className="page-narrow">
          <section className="card" style={{ marginTop: 26 }}>
            <span className="kicker">starting up</span>
            <h1>Reading the network</h1>
            <p className="lede">Checking the configuration and your session.</p>
            <div className="meter" aria-hidden="true">
              <div className="fill m-butter" style={{ width: "40%" }} />
            </div>
          </section>
        </main>
      </>
    );
  }

  if (view.name === "error") {
    return (
      <>
        <TopBar />
        <main className="page-narrow">
          <section className="card" style={{ marginTop: 26 }}>
            <span className="kicker">trouble</span>
            <h1>Something went wrong</h1>
            <ErrorNote message={view.message} />
            <div className="acts">
              <Button onClick={() => window.location.reload()}>Reload the page</Button>
            </div>
          </section>
        </main>
      </>
    );
  }

  return (
    <>
      {view.name === "landing" && (
        <Landing notice={view.notice} onLoggedIn={() => void route()} />
      )}

      {view.name === "setup" && config && (
        <Setup
          config={config}
          me={view.me}
          onDone={() => void route()}
          onSignOut={() => void onSignOut()}
        />
      )}

      {view.name === "dashboard" && config && (
        <Dashboard
          config={config}
          user={view.user}
          initial={view.vault}
          onSignOut={() => void onSignOut()}
        />
      )}
    </>
  );
}
