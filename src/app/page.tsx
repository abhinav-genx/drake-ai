"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentEvent } from "@/agent";

type StreamEvent = AgentEvent | { type: "done"; conversationId?: string };

interface FeedItem {
  id: string;
  kind: "user" | "response" | "log" | "spawn" | "finish" | "error";
  agentId: string;
  depth: number;
  text: string;
}

interface BrowserTab {
  /** Stable per-task id from the agent (survives across live-url/result events). */
  key: string;
  label: string;
  startingPage: string;
  liveUrl: string;
  status: "live" | "done" | "error";
  result?: string;
}

let feedSeq = 0;

// Browser-panel layout constants (must match the ScreenCard render size).
const CARD_WIDTH = 720;
const CARD_HEIGHT = 486; // iframe (440) + header/footer chrome
const CARD_GAP = 32;
const FEED_WIDTH = 400; // telemetry column width to keep panels clear of

interface AuthUser {
  id: string;
  email: string;
}

export default function Home() {
  // --- Auth ---
  const [authChecked, setAuthChecked] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => setUser(d.user ?? null))
      .catch(() => setUser(null))
      .finally(() => setAuthChecked(true));
  }, []);

  if (!authChecked) {
    return (
      <div className="flex h-screen w-full items-center justify-center">
        <BootLoader />
      </div>
    );
  }

  if (!user) {
    return <AuthGate onAuthed={setUser} />;
  }

  return <App user={user} onLogout={() => setUser(null)} />;
}

function App({
  user,
  onLogout,
}: {
  user: AuthUser;
  onLogout: () => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [running, setRunning] = useState(false);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [feedOpen, setFeedOpen] = useState(true);
  const feedEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Shared-login flow ("Use browser" → log in → "Save data").
  const [login, setLogin] = useState<{
    open: boolean;
    phase: "idle" | "starting" | "live" | "saving";
    liveUrl?: string;
    sessionId?: string;
    error?: string;
  }>({ open: false, phase: "idle" });
  const [hasLogin, setHasLogin] = useState(false);

  // Pannable / zoomable canvas view for the browser screens.
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const panRef = useRef<{
    active: boolean;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  }>({ active: false, startX: 0, startY: 0, originX: 0, originY: 0 });

  // Auto-fit: keep every open browser panel visible inside the canvas.
  // Once the user pans/zooms manually we stop auto-fitting until they hit
  // "fit" (or a new run starts).
  const canvasRef = useRef<HTMLDivElement>(null);
  const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 });
  const [autoFit, setAutoFit] = useState(true);
  // Number of columns the auto-fit engine chose (drives the flex-wrap width).
  const [gridCols, setGridCols] = useState(1);

  useEffect(() => {
    feedEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [feed]);

  // Track the canvas viewport size so we can fit panels into it.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const update = () =>
      setCanvasSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Compute a grid + scale that fits EVERY panel fully inside the viewport
  // (no overflow) while preserving each panel's aspect ratio, then centres the
  // whole cluster. We reserve room for the telemetry feed (left), the top HUD
  // controls, and the floating command bar (bottom).
  const computeFit = useCallback(
    (count: number, size: { w: number; h: number }) => {
      if (count === 0 || size.w === 0 || size.h === 0) {
        return { x: 0, y: 0, scale: 1, cols: 1 };
      }
      const CARD_W = CARD_WIDTH + CARD_GAP;
      const CARD_H = CARD_HEIGHT + CARD_GAP;

      // Insets (in canvas/viewport px) that panels must stay clear of.
      const leftInset = feedOpen ? FEED_WIDTH : 24; // telemetry column
      const rightInset = 24;
      const topInset = 64; // node counter / zoom controls row
      const bottomInset = 150; // floating command bar + hint

      const availW = Math.max(200, size.w - leftInset - rightInset);
      const availH = Math.max(200, size.h - topInset - bottomInset);

      // Pick the column count that maximises the fitted scale. Every candidate
      // is constrained to fit BOTH dimensions, so nothing ever overflows.
      let best = { cols: 1, scale: 0 };
      for (let cols = 1; cols <= count; cols++) {
        const rows = Math.ceil(count / cols);
        const gridW = cols * CARD_W - CARD_GAP;
        const gridH = rows * CARD_H - CARD_GAP;
        // No upper cap of 1 — panels may render at native size only if they
        // genuinely fit; otherwise they shrink to fit.
        const scale = Math.min(availW / gridW, availH / gridH);
        if (scale > best.scale) best = { cols, scale };
      }

      const cols = best.cols;
      const rows = Math.ceil(count / cols);
      const scale = Math.min(best.scale, 1); // don't upscale beyond native size
      const gridW = (cols * CARD_W - CARD_GAP) * scale;
      const gridH = (rows * CARD_H - CARD_GAP) * scale;
      const x = leftInset + (availW - gridW) / 2;
      const y = topInset + (availH - gridH) / 2;
      return { x, y, scale, cols };
    },
    [feedOpen],
  );

  // Re-fit whenever the number of panels or the viewport changes, unless the
  // user has taken manual control.
  useEffect(() => {
    if (!autoFit) return;
    if (tabs.length === 0) return;
    const { cols, ...v } = computeFit(tabs.length, canvasSize);
    setGridCols(cols);
    setView(v);
  }, [autoFit, tabs.length, canvasSize, computeFit]);

  const pushFeed = useCallback((item: Omit<FeedItem, "id">) => {
    feedSeq += 1;
    setFeed((prev) => [...prev, { ...item, id: `f-${feedSeq}` }]);
  }, []);

  const handleEvent = useCallback(
    (event: StreamEvent) => {
      switch (event.type) {
        case "response":
          pushFeed({ kind: "response", agentId: event.agentId, depth: event.depth, text: event.text });
          break;
        case "log":
          pushFeed({ kind: "log", agentId: event.agentId, depth: event.depth, text: event.text });
          break;
        case "sub_agents_spawned":
          pushFeed({
            kind: "spawn",
            agentId: event.agentId,
            depth: event.depth,
            text: `Spawning ${event.specs.length} browser sub-agent(s) in parallel:\n` +
              event.specs
                .map((s, i) => `  ${i + 1}. ${s.startingPage}${s.performAction ? ` — ${s.performAction}` : ""}`)
                .join("\n"),
          });
          break;
        case "browser_live_url": {
          const key = event.taskId;
          setTabs((prev) => {
            if (prev.some((t) => t.key === key)) return prev;
            return [
              ...prev,
              {
                key,
                label: event.label,
                startingPage: event.startingPage,
                liveUrl: event.liveUrl,
                status: "live",
              },
            ];
          });
          break;
        }
        case "sub_agent_result": {
          // Match by the stable taskId so we always close the exact right window,
          // even when several sub-agents share the same starting page.
          const keyToClose = event.taskId;
          setTabs((prev) =>
            prev.map((t) =>
              t.key === keyToClose
                ? {
                    ...t,
                    status: event.result.error ? "error" : "done",
                    result: event.result.error ?? event.result.agentSummary ?? "done",
                  }
                : t,
            ),
          );
          // Auto-close the finished browser window shortly after its work is done.
          window.setTimeout(() => {
            setTabs((prev) => prev.filter((t) => t.key !== keyToClose));
          }, 1500);
          break;
        }
        case "finish":
          pushFeed({ kind: "finish", agentId: event.agentId, depth: event.depth, text: event.text });
          break;
        case "error":
          pushFeed({ kind: "error", agentId: event.agentId, depth: event.depth, text: event.text });
          break;
        case "done":
          setRunning(false);
          if ("conversationId" in event && event.conversationId) {
            setConversationId(event.conversationId);
          }
          // Safety net: the run is over, so no browser is in use — clear any
          // windows that are still lingering (e.g. never received a result).
          window.setTimeout(() => setTabs([]), 1500);
          break;
      }
    },
    [pushFeed],
  );

  const run = useCallback(async () => {
    const task = prompt.trim();
    if (!task || running) return;

    setRunning(true);
    setTabs([]);
    // New run: hand control back to the auto-fit engine so panels are laid
    // out and scaled to fit as they stream in.
    setAutoFit(true);
    setView({ x: 0, y: 0, scale: 1 });
    setFeedOpen(true);
    pushFeed({ kind: "user", agentId: "you", depth: 0, text: task });
    setPrompt("");

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: task, conversationId }),
        signal: controller.signal,
      });

      if (res.status === 401) {
        onLogout();
        return;
      }

      if (!res.ok || !res.body) {
        const msg = await res.text().catch(() => res.statusText);
        pushFeed({ kind: "error", agentId: "root", depth: 0, text: msg || "Request failed" });
        setRunning(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";
        for (const chunk of chunks) {
          const line = chunk.trim();
          if (!line.startsWith("data:")) continue;
          try {
            handleEvent(JSON.parse(line.slice(5).trim()) as StreamEvent);
          } catch {
            /* ignore malformed chunk */
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        pushFeed({ kind: "error", agentId: "root", depth: 0, text: (err as Error).message });
      }
    } finally {
      setRunning(false);
    }
  }, [prompt, running, conversationId, pushFeed, handleEvent, onLogout]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setRunning(false);
    // Stopping ends the run, so no browser window is in use anymore.
    setTabs([]);
  }, []);

  // --- Canvas pan / zoom handlers ---
  const onCanvasPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Only start panning from empty canvas space (not from inside a screen card).
      if ((e.target as HTMLElement).closest("[data-screen-card]")) return;
      setAutoFit(false); // user takes manual control
      e.currentTarget.setPointerCapture(e.pointerId);
      panRef.current = {
        active: true,
        startX: e.clientX,
        startY: e.clientY,
        originX: view.x,
        originY: view.y,
      };
    },
    [view.x, view.y],
  );

  const onCanvasPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (!pan.active) return;
    setView((v) => ({
      ...v,
      x: pan.originX + (e.clientX - pan.startX),
      y: pan.originY + (e.clientY - pan.startY),
    }));
  }, []);

  const onCanvasPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    panRef.current.active = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }, []);

  const onCanvasWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (!e.ctrlKey && !e.metaKey) return; // pinch/ctrl-scroll to zoom
    e.preventDefault();
    setAutoFit(false); // user takes manual control
    setView((v) => {
      const scale = Math.min(2, Math.max(0.25, v.scale - e.deltaY * 0.0015));
      return { ...v, scale };
    });
  }, []);

  const zoomBy = useCallback((delta: number) => {
    setAutoFit(false); // user takes manual control
    setView((v) => ({ ...v, scale: Math.min(2, Math.max(0.25, v.scale + delta)) }));
  }, []);

  // "Fit": recompute the grid so every panel is visible again.
  const resetView = useCallback(() => {
    setAutoFit(true);
    const { cols, ...v } = computeFit(tabs.length, canvasSize);
    setGridCols(cols);
    setView(v);
  }, [computeFit, tabs.length, canvasSize]);

  // --- Shared login flow ---
  const loginApi = useCallback(
    async (body: Record<string, unknown>) => {
      const res = await fetch("/api/browser-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw new Error((data.error as string) || res.statusText);
      return data;
    },
    [],
  );

  // On mount, check whether any login data has been saved.
  useEffect(() => {
    loginApi({ action: "status" })
      .then((d) => setHasLogin(Boolean(d.hasLogin)))
      .catch(() => {});
  }, [loginApi]);

  const startLogin = useCallback(async () => {
    setLogin({ open: true, phase: "starting" });
    try {
      const d = await loginApi({ action: "start" });
      setLogin({
        open: true,
        phase: "live",
        liveUrl: d.liveUrl as string,
        sessionId: d.sessionId as string,
      });
    } catch (err) {
      setLogin({ open: true, phase: "idle", error: (err as Error).message });
    }
  }, [loginApi]);

  const saveLogin = useCallback(async () => {
    setLogin((l) => ({ ...l, phase: "saving" }));
    try {
      const sid = login.sessionId;
      if (sid) await loginApi({ action: "save", sessionId: sid });
      setHasLogin(true);
      setLogin({ open: false, phase: "idle" });
    } catch (err) {
      setLogin((l) => ({ ...l, phase: "live", error: (err as Error).message }));
    }
  }, [loginApi, login.sessionId]);

  const closeLogin = useCallback(async () => {
    // Best-effort: release the interactive session even if the user cancels.
    const sid = login.sessionId;
    if (sid) loginApi({ action: "save", sessionId: sid }).catch(() => {});
    setLogin({ open: false, phase: "idle" });
  }, [loginApi, login.sessionId]);

  const clearLogin = useCallback(async () => {
    if (!confirm("Delete all your saved login data (cookies & sessions)?")) return;
    try {
      await loginApi({ action: "clear" });
      setHasLogin(false);
    } catch {
      /* ignore */
    }
  }, [loginApi]);

  // --- Session controls ---
  const newChat = useCallback(() => {
    if (running) return;
    setConversationId(undefined);
    setFeed([]);
    setTabs([]);
  }, [running]);

  const logout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    onLogout();
  }, [onLogout]);

  return (
    <div className="relative flex h-screen w-full flex-col overflow-hidden text-[color:var(--foreground)]">
      {/* ==================== TOP HUD BAR ==================== */}
      <header className="relative z-30 flex items-center gap-3 px-6 py-3">
        <div className="flex items-center gap-3">
          <ArcReactorMark active={running} />
          <div className="leading-none">
            <div className="font-mono text-lg font-semibold tracking-[0.35em] text-hud-cyan hud-glow-text">
              DRAKE·AI
            </div>
            <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.25em] text-sky-300/50">
              orchestrator · parallel browser array
            </div>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <HudButton onClick={newChat} disabled={running}>
            New session
          </HudButton>

          <HudButton
            onClick={startLogin}
            title="Log into sites once; cookies are shared with every browser sub-agent."
          >
            <span
              className={`h-2 w-2 rounded-full ${hasLogin ? "bg-hud-teal hud-pulse text-hud-teal" : "bg-sky-300/30"}`}
            />
            <span>Use browser</span>
            <span className="text-[10px] text-sky-300/40">{hasLogin ? "AUTH OK" : "NO AUTH"}</span>
          </HudButton>

          {hasLogin && (
            <HudButton onClick={clearLogin} tone="danger" title="Delete your saved login data.">
              Clear
            </HudButton>
          )}

          <div className="hud-panel hud-corners ml-1 flex items-center gap-2 rounded-md px-3 py-1.5">
            <span
              className={`h-2 w-2 rounded-full ${running ? "bg-hud-cyan hud-pulse text-hud-cyan" : "bg-sky-300/25"}`}
            />
            <span
              className={`font-mono text-[10px] uppercase tracking-[0.2em] ${running ? "text-hud-cyan" : "text-sky-300/40"}`}
            >
              {running ? "online" : "standby"}
            </span>
          </div>

          <div className="hud-panel ml-1 flex items-center gap-2 rounded-md px-3 py-1.5">
            <span className="max-w-[150px] truncate font-mono text-[11px] text-sky-200/70" title={user.email}>
              {user.email}
            </span>
            <button
              type="button"
              onClick={logout}
              className="font-mono text-[10px] uppercase tracking-[0.2em] text-sky-300/50 transition hover:text-hud-red"
            >
              exit
            </button>
          </div>
        </div>
      </header>

      {/* ==================== MAIN HOLO CANVAS ==================== */}
      <main className="relative z-10 min-h-0 flex-1">
        <div
          ref={canvasRef}
          className="relative h-full w-full cursor-grab overflow-hidden active:cursor-grabbing"
          onPointerDown={onCanvasPointerDown}
          onPointerMove={onCanvasPointerMove}
          onPointerUp={onCanvasPointerUp}
          onPointerLeave={onCanvasPointerUp}
          onWheel={onCanvasWheel}
        >
          {/* Idle center core when nothing is running. */}
          {tabs.length === 0 && (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-6">
              <ArcReactorCore active={running} />
              <div className="text-center">
                <div className="font-mono text-sm uppercase tracking-[0.4em] text-hud-cyan/70 hud-glow-text">
                  {running ? "initializing agents" : "awaiting directive"}
                </div>
                <div className="mt-2 max-w-md font-mono text-[11px] leading-relaxed text-sky-300/40">
                  Issue a complex task below. DRAKE will deploy live browser sub-agents in
                  parallel across this holo-array.
                </div>
              </div>
            </div>
          )}

          {/* The movable / zoomable canvas layer with all live browser panels. */}
          <div
            className="absolute left-0 top-0 origin-top-left"
            style={{
              transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            }}
          >
            <div
              className="flex flex-wrap gap-8"
              style={{ width: gridCols * (CARD_WIDTH + CARD_GAP) - CARD_GAP }}
            >
              {tabs.map((t) => (
                <ScreenCard key={t.key} tab={t} />
              ))}
            </div>
          </div>

          {/* Canvas HUD controls (top-right, floating). */}
          {tabs.length > 0 && (
            <div className="pointer-events-auto absolute right-4 top-4 z-20 flex items-center gap-2">
              <div className="hud-panel hud-corners flex items-center gap-2 rounded-md px-3 py-1.5">
                <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-hud-cyan">
                  {tabs.length} node{tabs.length === 1 ? "" : "s"}
                </span>
              </div>
              <div className="hud-panel flex items-center gap-1 rounded-md px-2 py-1">
                <ZoomBtn onClick={() => zoomBy(-0.15)}>−</ZoomBtn>
                <span className="w-12 text-center font-mono text-[11px] text-sky-200/70">
                  {Math.round(view.scale * 100)}%
                </span>
                <ZoomBtn onClick={() => zoomBy(0.15)}>+</ZoomBtn>
                <button
                  onClick={resetView}
                  title="Fit all panels into view"
                  className={`ml-1 rounded font-mono text-[10px] uppercase tracking-widest transition ${
                    autoFit ? "text-hud-cyan hud-glow-text" : "text-sky-300/50 hover:text-hud-cyan"
                  }`}
                >
                  fit
                </button>
              </div>
            </div>
          )}

          {/* Canvas hint. */}
          <div className="pointer-events-none absolute bottom-4 left-4 z-20 font-mono text-[10px] uppercase tracking-[0.2em] text-sky-300/30">
            {autoFit ? "auto-fit on · " : ""}drag to pan · ⌘/ctrl+scroll to zoom · &ldquo;fit&rdquo; to re-fit
          </div>
        </div>
      </main>

      {/* ==================== FLOATING TELEMETRY FEED (left) ==================== */}
      <TelemetryFeed feed={feed} open={feedOpen} onToggle={() => setFeedOpen((o) => !o)} feedEndRef={feedEndRef} />

      {/* ==================== CENTER-BOTTOM COMMAND BAR ==================== */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-40 flex justify-center pb-7">
        <form
          className="pointer-events-auto w-full max-w-2xl px-4"
          onSubmit={(e) => {
            e.preventDefault();
            run();
          }}
        >
          <div className="hud-panel hud-corners hud-border-glow group relative overflow-hidden rounded-2xl px-4 py-3">
            {/* animated underline sweep */}
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px] hud-sweep opacity-70" />

            <div className="flex items-end gap-3">
              <span className="mb-1 shrink-0 font-mono text-xs tracking-widest text-hud-cyan/70 hud-glow-text">
                &gt;_
              </span>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    run();
                  }
                }}
                rows={1}
                placeholder="Speak your command, sir…  e.g. Compare the cheapest MacBook Air across Croma and Amazon India."
                className="max-h-40 min-h-[1.5rem] flex-1 resize-none bg-transparent font-mono text-sm text-sky-100 outline-none placeholder:text-sky-300/30"
                onInput={(e) => {
                  const el = e.currentTarget;
                  el.style.height = "auto";
                  el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
                }}
              />
              {/* Chat / fullscreen-browser toggle. Off = hide telemetry so the
                  browser windows fill the whole screen (chatbox stays at bottom). */}
              <button
                type="button"
                onClick={() => setFeedOpen((o) => !o)}
                title={feedOpen ? "Hide chat — view browser windows fullscreen" : "Show chat / telemetry"}
                aria-pressed={feedOpen}
                className={`group/toggle relative mb-0 flex h-9 shrink-0 items-center gap-2 rounded-xl border px-3 font-mono text-[10px] uppercase tracking-[0.15em] transition ${
                  feedOpen
                    ? "border-hud-cyan/50 bg-hud-cyan/10 text-hud-cyan"
                    : "border-sky-400/30 bg-sky-500/5 text-sky-300/60 hover:border-hud-cyan hover:text-hud-cyan"
                }`}
                style={feedOpen ? { boxShadow: "0 0 12px rgba(34,211,238,0.25)" } : undefined}
              >
                {feedOpen ? <ChatIcon /> : <BrowserIcon />}
                <span className="hidden sm:inline">{feedOpen ? "chat" : "screens"}</span>
              </button>
              {running ? (
                <button
                  type="button"
                  onClick={stop}
                  className="shrink-0 rounded-xl border border-hud-red/50 bg-hud-red/10 px-5 py-2 font-mono text-xs uppercase tracking-[0.2em] text-hud-red transition hover:bg-hud-red/20"
                  style={{ boxShadow: "0 0 16px rgba(248,113,113,0.35)" }}
                >
                  Abort
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!prompt.trim()}
                  className="shrink-0 rounded-xl border border-hud-cyan/50 bg-hud-cyan/10 px-6 py-2 font-mono text-xs uppercase tracking-[0.2em] text-hud-cyan transition hover:bg-hud-cyan/20 disabled:opacity-30"
                  style={{ boxShadow: "0 0 16px rgba(34,211,238,0.35)" }}
                >
                  Execute
                </button>
              )}
            </div>
          </div>
          <div className="mt-2 text-center font-mono text-[10px] uppercase tracking-[0.3em] text-sky-300/25">
            enter to execute · shift+enter for new line · toggle chat / fullscreen screens
          </div>
        </form>
      </div>

      {login.open && (
        <LoginModal
          phase={login.phase}
          liveUrl={login.liveUrl}
          error={login.error}
          onSave={saveLogin}
          onClose={closeLogin}
        />
      )}
    </div>
  );
}

/* ==================== HUD PRIMITIVES ==================== */

function HudButton({
  children,
  onClick,
  disabled,
  title,
  tone = "default",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  tone?: "default" | "danger";
}) {
  const toneCls =
    tone === "danger"
      ? "border-hud-red/40 text-hud-red/80 hover:border-hud-red hover:text-hud-red"
      : "border-sky-400/25 text-sky-200/80 hover:border-hud-cyan hover:text-hud-cyan";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`flex items-center gap-1.5 rounded-md border bg-sky-500/5 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.15em] backdrop-blur-sm transition disabled:opacity-30 ${toneCls}`}
    >
      {children}
    </button>
  );
}

function ZoomBtn({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex h-6 w-6 items-center justify-center rounded font-mono text-sm text-sky-200/70 transition hover:bg-hud-cyan/15 hover:text-hud-cyan"
    >
      {children}
    </button>
  );
}

/* Chat bubble icon (shown when chat/telemetry is visible). */
function ChatIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

/* Browser/monitor icon (shown when in fullscreen-screens mode). */
function BrowserIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <line x1="2" y1="7" x2="22" y2="7" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

/* A small arc-reactor style mark used in the header. */
function ArcReactorMark({ active }: { active: boolean }) {
  return (
    <div className="relative h-9 w-9">
      <div
        className={`absolute inset-0 rounded-full border ${active ? "border-hud-cyan/70" : "border-sky-400/30"} hud-ring`}
        style={{ borderTopColor: "transparent", borderLeftColor: "transparent" }}
      />
      <div
        className={`absolute inset-1 rounded-full border ${active ? "border-hud-teal/60" : "border-sky-400/20"} hud-ring-rev`}
        style={{ borderBottomColor: "transparent", borderRightColor: "transparent" }}
      />
      <div
        className={`absolute inset-[10px] rounded-full ${active ? "bg-hud-cyan hud-pulse text-hud-cyan" : "bg-sky-400/40"}`}
        style={{ boxShadow: active ? "0 0 12px var(--hud-cyan)" : undefined }}
      />
    </div>
  );
}

/* Large idle arc-reactor core shown in the empty canvas center. */
function ArcReactorCore({ active }: { active: boolean }) {
  return (
    <div className="relative h-56 w-56">
      <div className="absolute inset-0 rounded-full border-2 border-hud-cyan/25 hud-ring" style={{ borderStyle: "dashed" }} />
      <div className="absolute inset-6 rounded-full border border-sky-400/20 hud-ring-rev" />
      <div
        className="absolute inset-14 rounded-full border border-hud-teal/30 hud-ring"
        style={{ borderTopColor: "transparent", borderBottomColor: "transparent" }}
      />
      <div
        className={`absolute inset-[88px] rounded-full ${active ? "hud-pulse text-hud-cyan" : ""}`}
        style={{
          background: "radial-gradient(circle, rgba(34,211,238,0.9), rgba(34,211,238,0.1) 70%, transparent)",
          boxShadow: "0 0 40px rgba(34,211,238,0.5), 0 0 100px rgba(34,211,238,0.25)",
        }}
      />
    </div>
  );
}

function BootLoader() {
  return (
    <div className="flex flex-col items-center gap-5">
      <ArcReactorCore active />
      <div className="font-mono text-xs uppercase tracking-[0.4em] text-hud-cyan/70 hud-glow-text">
        booting drake core…
      </div>
    </div>
  );
}

/* ==================== FLOATING TELEMETRY FEED ==================== */

function TelemetryFeed({
  feed,
  open,
  onToggle,
  feedEndRef,
}: {
  feed: FeedItem[];
  open: boolean;
  onToggle: () => void;
  feedEndRef: React.RefObject<HTMLDivElement | null>;
}) {
  // In fullscreen-screens mode the whole chat panel is hidden; the command-bar
  // toggle is the control to bring it back.
  if (!open) return null;

  return (
    <div className="pointer-events-none absolute left-4 top-20 z-30 flex max-h-[calc(100vh-13rem)] w-[360px] flex-col">
      <button
        type="button"
        onClick={onToggle}
        title="Hide chat"
        className="pointer-events-auto mb-2 flex items-center gap-2 self-start rounded-md border border-sky-400/25 bg-sky-500/5 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.25em] text-sky-200/70 backdrop-blur-sm transition hover:border-hud-cyan hover:text-hud-cyan"
      >
        <span className={`h-1.5 w-1.5 rounded-full ${feed.length ? "bg-hud-cyan hud-pulse text-hud-cyan" : "bg-sky-400/30"}`} />
        telemetry ▾
        <span className="text-sky-300/40">({feed.length})</span>
      </button>

      <div
        className="hud-panel hud-corners pointer-events-auto flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl"
        style={{ background: "var(--hud-glass-strong)" }}
      >
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
          {feed.length === 0 && (
            <div className="py-6 text-center font-mono text-[11px] leading-relaxed text-sky-300/30">
              No telemetry yet. Awaiting your first directive.
            </div>
          )}
          {feed.map((item) => (
            <FeedRow key={item.id} item={item} />
          ))}
          <div ref={feedEndRef} />
        </div>
      </div>
    </div>
  );
}

/* ==================== AUTH ==================== */

function AuthGate({ onAuthed }: { onAuthed: (user: AuthUser) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      setBusy(true);
      try {
        const res = await fetch(`/api/auth/${mode}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          user?: AuthUser;
          error?: string;
        };
        if (!res.ok || !data.user) {
          throw new Error(data.error || "Something went wrong.");
        }
        onAuthed(data.user);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [mode, email, password, onAuthed],
  );

  return (
    <div className="relative flex h-screen w-full items-center justify-center">
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-40">
        <ArcReactorCore active />
      </div>
      <div className="hud-panel hud-corners hud-border-glow relative z-10 w-full max-w-sm rounded-2xl p-7">
        <div className="mb-1 flex items-center gap-3">
          <ArcReactorMark active />
          <div className="font-mono text-lg font-semibold tracking-[0.35em] text-hud-cyan hud-glow-text">
            DRAKE·AI
          </div>
        </div>
        <div className="mb-6 font-mono text-[10px] uppercase tracking-[0.25em] text-sky-300/50">
          {mode === "login" ? "identity verification" : "register new operator"}
        </div>

        <form onSubmit={submit} className="space-y-3">
          <HudInput
            type="email"
            required
            autoComplete="email"
            placeholder="operator@domain"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <HudInput
            type="password"
            required
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            placeholder={mode === "login" ? "access key" : "access key (min 8 chars)"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />

          {error && (
            <div className="rounded-md border border-hud-red/40 bg-hud-red/10 px-3 py-2 font-mono text-[11px] text-hud-red">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-md border border-hud-cyan/50 bg-hud-cyan/10 px-4 py-2.5 font-mono text-xs uppercase tracking-[0.25em] text-hud-cyan transition hover:bg-hud-cyan/20 disabled:opacity-40"
            style={{ boxShadow: "0 0 16px rgba(34,211,238,0.3)" }}
          >
            {busy ? "authenticating…" : mode === "login" ? "authenticate" : "register"}
          </button>
        </form>

        <button
          type="button"
          onClick={() => {
            setMode((m) => (m === "login" ? "register" : "login"));
            setError(null);
          }}
          className="mt-5 w-full text-center font-mono text-[10px] uppercase tracking-[0.2em] text-sky-300/40 transition hover:text-hud-cyan"
        >
          {mode === "login" ? "no clearance? register" : "already cleared? sign in"}
        </button>
      </div>
    </div>
  );
}

function HudInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className="w-full rounded-md border border-sky-400/25 bg-sky-950/40 px-3 py-2.5 font-mono text-sm text-sky-100 outline-none transition placeholder:text-sky-300/30 focus:border-hud-cyan/60 focus:bg-sky-950/60"
    />
  );
}

/* ==================== LOGIN MODAL ==================== */

function LoginModal({
  phase,
  liveUrl,
  error,
  onSave,
  onClose,
}: {
  phase: "idle" | "starting" | "live" | "saving";
  liveUrl?: string;
  error?: string;
  onSave: () => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm">
      <div className="hud-panel hud-corners hud-border-glow flex h-[85vh] w-[90vw] max-w-6xl flex-col overflow-hidden rounded-2xl">
        <div className="flex items-center gap-3 border-b border-sky-400/20 px-4 py-3">
          <span className="font-mono text-xs uppercase tracking-[0.2em] text-hud-cyan hud-glow-text">
            Shared browser session
          </span>
          <span className="font-mono text-[10px] text-sky-300/40">
            Sign into any sites (Gmail, YouTube, WhatsApp, Discord…). Then “Save” to share
            the login with every sub-agent.
          </span>
          <div className="ml-auto flex items-center gap-2">
            <HudButton onClick={onClose} disabled={phase === "saving"}>
              Cancel
            </HudButton>
            <button
              type="button"
              onClick={onSave}
              disabled={phase !== "live"}
              className="rounded-md border border-hud-teal/50 bg-hud-teal/10 px-4 py-1.5 font-mono text-[11px] uppercase tracking-[0.2em] text-hud-teal transition hover:bg-hud-teal/20 disabled:opacity-30"
            >
              {phase === "saving" ? "saving…" : "save data"}
            </button>
          </div>
        </div>

        {error && (
          <div className="border-b border-hud-red/40 bg-hud-red/10 px-4 py-2 font-mono text-[11px] text-hud-red">
            {error}
          </div>
        )}

        <div className="relative min-h-0 flex-1 bg-black/40">
          {phase === "starting" || !liveUrl ? (
            <div className="flex h-full flex-col items-center justify-center gap-4">
              <ArcReactorCore active />
              <div className="font-mono text-xs uppercase tracking-[0.3em] text-hud-cyan/60">
                spinning up secure session…
              </div>
            </div>
          ) : (
            <iframe
              src={liveUrl}
              title="Login session"
              className="h-full w-full border-0"
              sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
              allow="clipboard-read; clipboard-write"
            />
          )}
        </div>
      </div>
    </div>
  );
}

/* ==================== BROWSER SCREEN PANEL ==================== */

function ScreenCard({ tab }: { tab: BrowserTab }) {
  const finished = tab.status !== "live";
  const dot =
    tab.status === "live"
      ? "bg-hud-cyan hud-pulse text-hud-cyan"
      : tab.status === "error"
        ? "bg-hud-red text-hud-red"
        : "bg-hud-teal text-hud-teal";

  // Pick the neon frame variant for the current status.
  const neon =
    tab.status === "error"
      ? "neon-frame neon-frame-error"
      : tab.status === "live"
        ? "neon-frame"
        : "neon-frame neon-frame-idle";

  return (
    <div
      data-screen-card
      className={`${neon} hud-flicker w-[720px] transition-all duration-500 ${
        finished ? "opacity-70 saturate-50" : "opacity-100"
      }`}
    >
      <div
        className="flex flex-col overflow-hidden rounded-[0.72rem]"
        style={{
          // Solid backdrop so nothing (telemetry / other panels) bleeds through
          // while a live feed is loading.
          background: "#03080f",
        }}
      >
        <div className="flex items-center gap-2 border-b border-sky-400/20 px-3 py-2">
          <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
          <span className="font-mono text-[11px] uppercase tracking-[0.15em] text-hud-cyan">{tab.label}</span>
          <span className="truncate font-mono text-[10px] text-sky-300/40">{tab.startingPage}</span>
          <a
            href={tab.liveUrl}
            target="_blank"
            rel="noreferrer"
            className="ml-auto shrink-0 font-mono text-[10px] uppercase tracking-widest text-sky-300/40 transition hover:text-hud-cyan"
          >
            open ↗
          </a>
        </div>
        <div className="relative">
          <iframe
            src={tab.liveUrl}
            title={tab.label}
            className="h-[440px] w-full border-0 bg-[#0b0f14]"
            sandbox="allow-same-origin allow-scripts"
            allow="clipboard-read; clipboard-write"
          />
          {/* subtle screen scanline sheen over each live feed */}
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "repeating-linear-gradient(to bottom, transparent 0 3px, rgba(34,211,238,0.035) 3px 4px)",
            }}
          />
        </div>
        {tab.result && (
          <div className="border-t border-sky-400/20 bg-sky-950/30 px-3 py-2 font-mono text-[11px] text-sky-200/70">
            {tab.result}
          </div>
        )}
      </div>
    </div>
  );
}

/* ==================== FEED ROW ==================== */

function FeedRow({ item }: { item: FeedItem }) {
  const indent = Math.min(item.depth, 3) * 12;

  if (item.kind === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[90%] whitespace-pre-wrap rounded-lg rounded-br-sm border border-hud-cyan/40 bg-hud-cyan/10 px-3 py-2 font-mono text-[12px] text-sky-100">
          {item.text}
        </div>
      </div>
    );
  }

  const styles: Record<FeedItem["kind"], string> = {
    user: "",
    response: "border border-sky-400/20 bg-sky-500/5 text-sky-100",
    log: "text-sky-300/40",
    spawn: "border border-hud-blue/30 bg-hud-blue/10 text-sky-200 whitespace-pre-wrap",
    finish: "border border-hud-teal/40 bg-hud-teal/10 text-hud-teal",
    error: "border border-hud-red/40 bg-hud-red/10 text-hud-red",
  };

  const badge: Record<FeedItem["kind"], string> = {
    user: "",
    response: "◆",
    log: "›",
    spawn: "⧉",
    finish: "✓",
    error: "!",
  };

  return (
    <div style={{ marginLeft: indent }} className="flex">
      <div
        className={`max-w-[95%] whitespace-pre-wrap rounded-lg px-2.5 py-1.5 font-mono text-[11px] leading-relaxed ${styles[item.kind]}`}
      >
        <span className="mr-1.5 select-none opacity-60">
          {badge[item.kind]} <span className="text-[9px] uppercase tracking-widest">{item.agentId}</span>
        </span>
        {item.text}
      </div>
    </div>
  );
}
