// Where share notes can go, from environment variables read where main starts. Nothing is set by
// default, so share notes stay off until a destination is configured.

/** `0` (or `off`) keeps share notes off even with a destination configured. */
export const SHARE_ENV = "PI_SIDEBAR_SHARE";
export const BLUESKY_HANDLE_ENV = "PI_SIDEBAR_BLUESKY_HANDLE";
export const BLUESKY_PASSWORD_ENV = "PI_SIDEBAR_BLUESKY_APP_PASSWORD";
/** The account's PDS (default https://bsky.social). */
export const BLUESKY_SERVICE_ENV = "PI_SIDEBAR_BLUESKY_SERVICE";
/** A directory blog drafts are written to as markdown files. */
export const DRAFTS_DIR_ENV = "PI_SIDEBAR_DRAFTS_DIR";
/** A shell command that saves a blog draft (markdown on stdin); overrides the directory. */
export const DRAFTS_COMMAND_ENV = "PI_SIDEBAR_DRAFTS_COMMAND";

export const DEFAULT_BLUESKY_SERVICE = "https://bsky.social";

export interface BlueskyConfig {
  handle: string;
  password: string;
  service: string;
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
    config.bluesky = { handle, password, service: (env[BLUESKY_SERVICE_ENV]?.trim() || DEFAULT_BLUESKY_SERVICE).replace(/\/+$/, "") };
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
    ...(config.bluesky ? [`Bluesky as @${config.bluesky.handle}`] : []),
    ...(config.drafts?.command ? ["blog drafts through your drafts command"] : config.drafts?.dir ? [`blog drafts in ${config.drafts.dir}`] : []),
  ];
  return `Share notes are on: ${where.join("; ")}.`;
}
