// Every git and gh step is a standard command; this is the one way they run.
export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type Exec = (cmd: string, args: string[], cwd: string, timeoutMs?: number) => Promise<ExecResult>;

/** Runs a shell command line (`bash -c`) in `cwd`; stdout and stderr come back combined in `stdout`. */
export async function shell(exec: Exec, command: string, cwd: string, timeoutMs: number): Promise<{ output: string; code: number }> {
  const r = await exec("bash", ["-c", `${command} 2>&1`], cwd, timeoutMs);
  return { output: r.stdout + (r.stderr ? `\n${r.stderr}` : ""), code: r.code };
}

/** The last `n` lines of `text`, each clipped to `width` characters. */
export function tail(text: string, n: number, width = 300): string {
  return text
    .split("\n")
    .slice(-n)
    .map((l) => (l.length > width ? `${l.slice(0, width)}…` : l))
    .join("\n")
    .trim();
}
