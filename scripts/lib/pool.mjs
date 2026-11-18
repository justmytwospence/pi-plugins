// Shared by scripts/test-suite.mjs and scripts/check-components.mjs: a small process pool,
// the environment children run in, and the Node guard.
import { spawn } from 'node:child_process';

export function jobs(fallback) {
  const n = Number(process.env.PI_CHECK_JOBS);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// The parent's agent state must not leak into tests: the subagent, sidebar and tool-gate
// variables describe the running session, and HERDR_*/TMUX* would let a test reach (and
// report to) the live multiplexer pane.
export function cleanEnv(base = process.env) {
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (key === 'PI_SUBAGENT' || key === 'PI_SUBAGENT_DEPTH' || key === 'PI_SIDEBAR_FAMILY'
      || key === 'TMUX' || key === 'TMUX_PANE'
      || key.startsWith('PI_TOOL_GATE_') || key.startsWith('HERDR_')) delete env[key];
  }
  return env;
}

export function requireNode(major = 24) {
  const found = Number(process.versions.node.split('.')[0]);
  if (found < major) {
    console.error(`Node >= ${major} required (found v${process.versions.node}); run \`nvm use\``);
    process.exit(1);
  }
}

function runOne(task, inherit) {
  return new Promise((resolve) => {
    const started = Date.now();
    let output = '';
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      resolve({ name: task.name, code, ms: Date.now() - started, output });
    };
    const child = spawn(task.command, task.args ?? [], {
      cwd: task.cwd,
      env: task.env,
      stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
    if (!inherit) {
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.stderr.on('data', (chunk) => { output += chunk; });
    }
    child.on('error', (error) => { output += `${error.message}\n`; finish(1); });
    child.on('close', (code, signal) => finish(signal ? 1 : code ?? 1));
  });
}

// Runs the non-serial tasks at most `concurrency` at a time, then the serial ones one by one.
// Resolves to [{ name, code, ms, output }] in completion order.
export async function runTasks(tasks, { concurrency, onDone = () => {} }) {
  const inherit = concurrency === 1;
  const results = [];
  const record = (result) => { results.push(result); onDone(result); };
  const queue = tasks.filter((task) => !task.serial);
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, async () => {
    for (let task = queue.shift(); task; task = queue.shift()) record(await runOne(task, inherit));
  });
  await Promise.all(workers);
  for (const task of tasks.filter((t) => t.serial)) record(await runOne(task, inherit));
  return results;
}

export function printDone({ name, code, ms }) {
  console.log(`${code === 0 ? 'ok  ' : 'FAIL'} ${(ms / 1000).toFixed(1).padStart(6)}s ${name}`);
}

export function report(results) {
  const failed = results.filter((r) => r.code !== 0);
  for (const r of failed) {
    console.error(`\nFAIL ${r.name} (${(r.ms / 1000).toFixed(1)}s)`);
    if (r.output) console.error(r.output.trimEnd());
  }
  console.log('');
  for (const r of [...results].sort((a, b) => b.ms - a.ms)) {
    console.log(`  ${(r.ms / 1000).toFixed(1).padStart(6)}s  ${r.code === 0 ? 'ok  ' : 'FAIL'}  ${r.name}`);
  }
  const total = results.reduce((sum, r) => sum + r.ms, 0);
  console.log(`  ${failed.length ? `${failed.length} failed of` : 'all'} ${results.length} tasks, ${(total / 1000).toFixed(1)}s of work`);
  return failed.length === 0;
}
