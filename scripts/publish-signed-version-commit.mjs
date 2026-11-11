#!/usr/bin/env node

// Publishes the local version commit (HEAD) to the version branch through the Git Data API.
// A commit created there with an App token and no explicit author is signed by GitHub and
// shows as Verified; a commit pushed with git never is, and main requires signed commits.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function api(method, path, body) {
  const out = execFileSync('gh', ['api', '--method', method, path, ...(body ? ['--input', '-'] : [])], {
    encoding: 'utf8',
    input: body ? JSON.stringify(body) : undefined,
    maxBuffer: 64 * 1024 * 1024,
  });
  return out ? JSON.parse(out) : {};
}

const repo = process.env.GITHUB_REPOSITORY;
const branch = process.env.BRANCH;
if (!repo || !branch) throw new Error('GITHUB_REPOSITORY and BRANCH are required.');
if (!branch.startsWith('changeset-release/')) {
  throw new Error(`Refusing to force-publish version commit to non-release branch ${branch}.`);
}

const parent = git('rev-parse', 'HEAD~1');
const localTree = git('rev-parse', 'HEAD^{tree}');
const changes = git('diff', '--no-renames', '--name-status', '-z', 'HEAD~1', 'HEAD').split('\0').filter(Boolean);

const tree = [];
for (let index = 0; index < changes.length; index += 2) {
  const status = changes[index];
  const path = changes[index + 1];
  if (status === 'D') {
    tree.push({ path, mode: '100644', type: 'blob', sha: null });
    continue;
  }
  const mode = git('--literal-pathspecs', 'ls-tree', 'HEAD', '--', path).split(/\s/u)[0];
  if (mode !== '100644' && mode !== '100755') throw new Error(`Unsupported file mode ${mode} for ${path}.`);
  const blob = api('POST', `repos/${repo}/git/blobs`, { content: readFileSync(path).toString('base64'), encoding: 'base64' });
  tree.push({ path, mode, type: 'blob', sha: blob.sha });
}

const created = api('POST', `repos/${repo}/git/trees`, { base_tree: git('rev-parse', 'HEAD~1^{tree}'), tree });
if (created.sha !== localTree) throw new Error(`Published tree ${created.sha} differs from the validated tree ${localTree}.`);

const commit = api('POST', `repos/${repo}/git/commits`, { message: git('log', '-1', '--format=%B'), tree: created.sha, parents: [parent] });
if (commit.verification?.verified !== true) throw new Error(`Commit ${commit.sha} was not signed by GitHub.`);

// The branch is a disposable projection of main plus the pending changesets, so it is replaced.
try {
  api('PATCH', `repos/${repo}/git/refs/heads/${branch}`, { sha: commit.sha, force: true });
} catch {
  api('POST', `repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
}
console.log(`Published signed version commit ${commit.sha} to ${branch}.`);
