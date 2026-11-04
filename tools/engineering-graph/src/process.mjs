import { spawn } from 'node:child_process';

export function runProcess(command, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const limit = 1024 * 1024;
    const timer = setTimeout(() => child.kill('SIGTERM'), 20 * 60 * 1000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > limit) child.kill('SIGTERM');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > limit) child.kill('SIGTERM');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && !signal) resolve(stdout);
      else reject(new Error(command + ' exited ' + String(code ?? signal) + ': ' + [stderr, stdout].filter(Boolean).join('\n').slice(-6000)));
    });
  });
}
