import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export async function gitInfo(cwd, run = execFileP) {
  if (!cwd) return null;
  try {
    const git = async (...args) => (await run('git', ['-C', cwd, ...args])).stdout;
    // symbolic-ref works on any git version and on repos with no commits; it fails on a detached HEAD.
    const branch = (await git('symbolic-ref', '--short', '-q', 'HEAD').catch(() => '')).trim() || '(detached)';
    const dirtyFiles = (await git('status', '--porcelain')).split('\n').filter(Boolean).length;
    const toplevel = (await git('rev-parse', '--show-toplevel')).trim();
    return { branch, dirty_files: dirtyFiles, toplevel };
  } catch {
    return null;
  }
}
