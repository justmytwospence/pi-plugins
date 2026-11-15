// Switchyard's web-only dialogs, for an extension that draws its own terminal dialog.
//
// When this Pi runs as a Switchyard terminal session, Switchyard's terminal extension answers a
// synchronous request over `pi.events` with `ui`: select/confirm/input/editor dialogs shown only to
// remote clients (phones, browsers). The extension races its terminal dialog against them; the
// first answer wins. Without Switchyard the request comes back unanswered. Copied per package;
// nothing imports across package directories.
export const REMOTE_UI_CHANNEL = "switchyard.remote-ui.v1";

export interface RemoteUi {
  select(title: string, options: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined>;
  confirm(title: string, message: string, opts?: { signal?: AbortSignal }): Promise<boolean>;
  input(title: string, placeholder?: string, opts?: { signal?: AbortSignal }): Promise<string | undefined>;
  editor(title: string, prefill?: string, opts?: { signal?: AbortSignal }): Promise<string | undefined>;
}

/** Switchyard's web-only dialogs when this Pi runs as a Switchyard terminal session. */
export function remoteUi(pi: { events?: { emit?(channel: string, data: unknown): void } }): RemoteUi | undefined {
  const request: { version: 1; ui?: RemoteUi } = { version: 1 };
  try {
    pi.events?.emit?.(REMOTE_UI_CHANNEL, request);
  } catch {
    /* optional provider */
  }
  return request.ui;
}

/** Race a terminal dialog against web-only dialogs: the remote side starts first; the loser is aborted. */
export async function raceRemote<T>(
  terminal: (signal: AbortSignal) => Promise<T | undefined>,
  remote: (signal: AbortSignal) => Promise<T | undefined>,
  outer?: AbortSignal,
): Promise<{ value: T | undefined; from: "terminal" | "remote" }> {
  if (outer?.aborted) return { value: undefined, from: "terminal" };
  const rc = new AbortController();
  const tc = new AbortController();
  const onOuter = () => {
    rc.abort("pi");
    tc.abort();
  };
  outer?.addEventListener("abort", onOuter, { once: true });
  try {
    // Capture synchronous throws too, without delaying remote-first registration.
    const start = (dialog: (signal: AbortSignal) => Promise<T | undefined>, signal: AbortSignal) => {
      try {
        return Promise.resolve(dialog(signal));
      } catch (error) {
        return Promise.reject(error);
      }
    };
    const r = start(remote, rc.signal).then((value) => ({ value, from: "remote" as const }));
    void r.catch(() => {});
    const t = start(terminal, tc.signal).then((value) => ({ value, from: "terminal" as const }));
    void t.catch(() => {});
    const winner = await Promise.race([r, t]);
    if (winner.from === "terminal") rc.abort("terminal");
    return winner;
  } finally {
    // Failure is not a reason to reopen an approval. Retire both dialog owners on every exit.
    rc.abort("pi");
    tc.abort();
    outer?.removeEventListener("abort", onOuter);
  }
}
