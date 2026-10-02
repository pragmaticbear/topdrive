// topdrive §48: repository evidence for handoffs. Read-only git; any failure degrades to null — never throws, never mutates.
export type GitExec = (args: string[]) => Promise<string>;
export interface RepoEvidence { branch: string | null; sha: string | null; dirty: boolean | null; changedPaths: string[] }

export async function collectRepoEvidence(git: GitExec): Promise<RepoEvidence> {
  const run = async (...args: string[]) => { try { return (await git(args)).trim(); } catch { return null; } };
  const [branch, sha, status, diff] = await Promise.all([
    run("rev-parse", "--abbrev-ref", "HEAD"), run("rev-parse", "HEAD"), run("status", "--porcelain"), run("diff", "--name-only", "HEAD"),
  ]);
  return { branch, sha, dirty: status === null ? null : status.length > 0, changedPaths: diff ? diff.split("\n").filter(Boolean) : [] };
}
