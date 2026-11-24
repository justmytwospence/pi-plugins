// Every GitHub and git step is a standard command (gh, git); this is the one way they run.
export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type Exec = (cmd: string, args: string[], cwd: string) => Promise<ExecResult>;

/** Runs a command and returns its stdout; a non-zero exit throws with its stderr. */
export async function run(exec: Exec, cmd: string, args: string[], cwd: string): Promise<string> {
  const r = await exec(cmd, args, cwd);
  if (r.code !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${r.stderr.trim() || `exit ${r.code}`}`);
  return r.stdout;
}
