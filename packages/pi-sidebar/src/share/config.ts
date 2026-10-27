// Where share notes can go, from environment variables read where main starts. Nothing is set by
// default, so share notes stay off until a destination is configured.

/** `0` (or `off`) keeps share notes off even with a destination configured. */
export const SHARE_ENV = "PI_SIDEBAR_SHARE";
export const BLUESKY_HANDLE_ENV = "PI_SIDEBAR_BLUESKY_HANDLE";
export const BLUESKY_PASSWORD_ENV = "PI_SIDEBAR_BLUESKY_APP_PASSWORD";
/** The account's PDS. By default it is resolved from the handle (works for bsky.social and self-hosted). */
export const BLUESKY_SERVICE_ENV = "PI_SIDEBAR_BLUESKY_SERVICE";
/** The web app post links point at (default https://bsky.app); `none` reports the at:// URI. */
export const BLUESKY_WEB_ENV = "PI_SIDEBAR_BLUESKY_WEB";
/** The did:plc directory used to resolve the PDS (default https://plc.directory). */
export const BLUESKY_PLC_ENV = "PI_SIDEBAR_BLUESKY_PLC";
/** A directory blog drafts are written to as markdown files. */
export const DRAFTS_DIR_ENV = "PI_SIDEBAR_DRAFTS_DIR";
/** A shell command that saves a blog draft (markdown on stdin); overrides the directory. */
export const DRAFTS_COMMAND_ENV = "PI_SIDEBAR_DRAFTS_COMMAND";

export const DEFAULT_BLUESKY_WEB = "https://bsky.app";
export const DEFAULT_PLC = "https://plc.directory";

export interface BlueskyConfig {
  /** A handle or a DID. */
  handle: string;
  password: string;
  /** The PDS; resolved from the handle when not set. */
  service?: string;
  /** Post links' web app, or undefined for at:// URIs. */
  web?: string;
  plc: string;
}

export interface DraftsConfig {
  dir?: string;
  command?: string;
}

export interface ShareConfig {
  bluesky?: BlueskyConfig;
  drafts?: DraftsConfig;
}

function expandHome(value: string, home: string | undefined): string {
  return home && (value === "~" || value.startsWith("~/")) ? `${home}${value.slice(1)}` : value;
}

export function shareConfig(env: NodeJS.ProcessEnv = process.env): ShareConfig {
  const off = env[SHARE_ENV]?.trim().toLowerCase();
  if (off === "0" || off === "off" || off === "false" || off === "no") return {};
  const config: ShareConfig = {};
  const handle = env[BLUESKY_HANDLE_ENV]?.trim().replace(/^@/, "");
  const password = env[BLUESKY_PASSWORD_ENV]?.trim();
  if (handle && password) {
    const url = (value: string | undefined) => value?.trim().replace(/\/+$/, "") || undefined;
    const service = url(env[BLUESKY_SERVICE_ENV]);
    const webRaw = env[BLUESKY_WEB_ENV]?.trim();
    const web = webRaw?.toLowerCase() === "none" ? undefined : url(webRaw) ?? DEFAULT_BLUESKY_WEB;
    config.bluesky = { handle, password, ...(service ? { service } : {}), ...(web ? { web } : {}), plc: url(env[BLUESKY_PLC_ENV]) ?? DEFAULT_PLC };
  }
  const command = env[DRAFTS_COMMAND_ENV]?.trim();
  const dir = env[DRAFTS_DIR_ENV]?.trim();
  if (command) config.drafts = { command };
  else if (dir) config.drafts = { dir: expandHome(dir, env.HOME) };
  return config;
}

/** Whether any share destination is configured (share notes are only asked for then). */
export function shareEnabled(config: ShareConfig): boolean {
  return !!(config.bluesky || config.drafts);
}

/** One line for `/sidebar headsup`. */
export function shareSummary(config: ShareConfig): string {
  if (!shareEnabled(config)) return `Share notes are off: set ${BLUESKY_HANDLE_ENV} and ${BLUESKY_PASSWORD_ENV}, or ${DRAFTS_DIR_ENV} or ${DRAFTS_COMMAND_ENV}, to turn them on.`;
  const where = [
    ...(config.bluesky ? [`Bluesky as @${config.bluesky.handle}${config.bluesky.service ? ` on ${config.bluesky.service}` : ""}`] : []),
    ...(config.drafts?.command ? ["blog drafts through your drafts command"] : config.drafts?.dir ? [`blog drafts in ${config.drafts.dir}`] : []),
  ];
  return `Share notes are on: ${where.join("; ")}.`;
}
