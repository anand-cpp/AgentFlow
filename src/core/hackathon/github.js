// GitHub integration for Hackathon Mode.
//
// Manages the shared repository, worker branches, commits, pushes, and
// integration workflow. One shared repository with:
//   - Protected main branch
//   - Session-specific integration branch
//   - Isolated working branch per worker
//
// Workers never push to main. The Admin Agent integrates approved worker
// branches into the integration branch. Final promotion to main requires
// explicit user approval.
//
// Uses the GitHub REST API with an authenticated token. The Admin's token
// is never distributed to workers — workers push to their own branches
// using scoped credentials or through the Admin.

import { spawnSync } from "node:child_process";
import process from "node:process";

const GITHUB_API_BASE = "https://api.github.com";

/** Result of a GitHub operation. */
export class GitHubResult {
  constructor({ ok, error, data } = {}) {
    this.ok = ok;
    this.error = error;
    this.data = data;
  }
  static ok(data) { return new GitHubResult({ ok: true, data }); }
  static err(error) { return new GitHubResult({ ok: false, error }); }
}

/**
 * GitHubIntegration — repository and branch management for Hackathon Mode.
 *
 * Coordinates GitHub operations: repository creation/initialization,
 * worker branch creation, commit/push, pull requests, and integration.
 * All operations require explicit authorization and are audited.
 */
export class GitHubIntegration {
  constructor({
    token = null,
    owner = null,
    repo = null,
    baseUrl = GITHUB_API_BASE,
    sessionId = null,
  } = {}) {
    this.token = token || process.env.GITHUB_TOKEN || null;
    this.owner = owner || process.env.GITHUB_OWNER || null;
    this.repo = repo || process.env.GITHUB_REPO || null;
    this.baseUrl = baseUrl;
    this.sessionId = sessionId;

    // Local git state
    this._localRepo = null; // path to local clone
    this._integrationBranch = null; // hackathon/<session>/integration
    this._workerBranches = new Map(); // workerId -> branch name
  }

  /** Whether GitHub is configured (token + owner + repo). */
  get isConfigured() {
    return Boolean(this.token && this.owner && this.repo);
  }

  /** Get auth headers for GitHub API requests. */
  _authHeaders() {
    if (!this.token) return {};
    return { Authorization: `Bearer ${this.token}` };
  }

  /** Make a GitHub API request. */
  async _apiRequest(endpoint, options = {}) {
    if (!this.token) {
      throw new Error("GitHub token not configured");
    }

    const url = `${this.baseUrl}${endpoint}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch(url, {
        method: options.method || "GET",
        headers: {
          ...this._authHeaders(),
          "Accept": "application/vnd.github+json",
          "Content-Type": "application/json",
          ...options.headers,
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      const body = response.headers.get("content-type")?.includes("application/json")
        ? await response.json()
        : await response.text();

      if (!response.ok) {
        throw new Error(
          `GitHub API ${response.status}: ${body.message || JSON.stringify(body).slice(0, 200)}`,
        );
      }

      return body;
    } catch (err) {
      clearTimeout(timeout);
      throw err;
    }
  }

  /** Create or initialize the shared repository. Requires user authorization. */
  async initializeRepository({ owner, repo, private: isPrivate = true, autoInit = true } = {}) {
    if (!this.token) {
      return GitHubResult.err(new Error("GitHub token required for repository creation"));
    }

    const targetOwner = owner || this.owner;
    const targetRepo = repo || this.repo;
    if (!targetOwner || !targetRepo) {
      return GitHubResult.err(new Error("owner and repo required"));
    }

    // Check if repository already exists.
    try {
      const existing = await this._apiRequest(`/repos/${targetOwner}/${targetRepo}`);
      this.owner = targetOwner;
      this.repo = targetRepo;
      return GitHubResult.ok({
        created: false,
        fullName: existing.full_name,
        defaultBranch: existing.default_branch,
        htmlUrl: existing.html_url,
      });
    } catch {
      // Repository doesn't exist — create it.
    }

    const created = await this._apiRequest("/user/repos", {
      method: "POST",
      body: {
        name: targetRepo,
        private: isPrivate,
        auto_init: autoInit,
      },
    });

    this.owner = targetOwner;
    this.repo = targetRepo;

    return GitHubResult.ok({
      created: true,
      fullName: created.full_name,
      defaultBranch: created.default_branch,
      htmlUrl: created.html_url,
    });
  }

  /** Get the integration branch name for this session. */
  getIntegrationBranch() {
    if (this._integrationBranch) return this._integrationBranch;
    if (this.sessionId) {
      this._integrationBranch = `hackathon/${this.sessionId}/integration`;
    }
    return this._integrationBranch;
  }

  /** Get the worker branch name. */
  getWorkerBranch(workerId) {
    if (this._workerBranches.has(workerId)) {
      return this._workerBranches.get(workerId);
    }
    if (this.sessionId) {
      const branch = `hackathon/${this.sessionId}/worker-${workerId}`;
      this._workerBranches.set(workerId, branch);
      return branch;
    }
    return null;
  }

  /** Create the integration branch from main. Requires write access. */
  async createIntegrationBranch({ baseBranch = "main" } = {}) {
    if (!this.isConfigured) {
      return GitHubResult.err(new Error("GitHub not configured"));
    }

    const integrationBranch = this.getIntegrationBranch();
    if (!integrationBranch) {
      return GitHubResult.err(new Error("sessionId required for integration branch"));
    }

    // Get the SHA of the base branch.
    const ref = await this._apiRequest(
      `/repos/${this.owner}/${this.repo}/git/ref/heads/${baseBranch}`,
    );
    const baseSha = ref.object.sha;

    // Create the integration branch.
    await this._apiRequest(
      `/repos/${this.owner}/${this.repo}/git/refs`,
      {
        method: "POST",
        body: {
          ref: `refs/heads/${integrationBranch}`,
          sha: baseSha,
        },
      },
    );

    return GitHubResult.ok({
      branch: integrationBranch,
      baseBranch,
      baseSha,
    });
  }

  /** Create a worker branch from the integration branch. */
  async createWorkerBranch({ workerId, baseBranch = null } = {}) {
    if (!this.isConfigured) {
      return GitHubResult.err(new Error("GitHub not configured"));
    }

    const workerBranch = this.getWorkerBranch(workerId);
    if (!workerBranch) {
      return GitHubResult.err(new Error("sessionId required for worker branch"));
    }

    const sourceBranch = baseBranch || this.getIntegrationBranch() || "main";

    // Get the SHA of the source branch.
    const ref = await this._apiRequest(
      `/repos/${this.owner}/${this.repo}/git/ref/heads/${sourceBranch}`,
    );
    const sourceSha = ref.object.sha;

    // Create the worker branch.
    await this._apiRequest(
      `/repos/${this.owner}/${this.repo}/git/refs`,
      {
        method: "POST",
        body: {
          ref: `refs/heads/${workerBranch}`,
          sha: sourceSha,
        },
      },
    );

    return GitHubResult.ok({
      workerId,
      branch: workerBranch,
      sourceBranch,
      sourceSha,
    });
  }

  /** Get file contents from a branch. */
  async getFileContents({ path: filePath, branch = "main" } = {}) {
    if (!this.isConfigured) {
      return GitHubResult.err(new Error("GitHub not configured"));
    }

    try {
      const result = await this._apiRequest(
        `/repos/${this.owner}/${this.repo}/contents/${encodeURIComponent(filePath)}?ref=${branch}`,
      );
      return GitHubResult.ok({
        content: result.content,
        encoding: result.encoding,
        sha: result.sha,
        size: result.size,
      });
    } catch (err) {
      return GitHubResult.err(err);
    }
  }

  /** Create or update a file on a worker branch. */
  async upsertFile({ workerId, filePath, content, message, branch = null, sha = null } = {}) {
    if (!this.isConfigured) {
      return GitHubResult.err(new Error("GitHub not configured"));
    }

    const targetBranch = branch || this.getWorkerBranch(workerId);
    if (!targetBranch) {
      return GitHubResult.err(new Error("workerId or branch required"));
    }

    const body = {
      message: message || `Update ${filePath} (worker ${workerId})`,
      content: Buffer.from(content).toString("base64"),
      branch: targetBranch,
    };
    if (sha) body.sha = sha;

    const result = await this._apiRequest(
      `/repos/${this.owner}/${this.repo}/contents/${encodeURIComponent(filePath)}`,
      { method: "PUT", body },
    );

    return GitHubResult.ok({
      commit: result.commit,
      content: result.content,
    });
  }

  /** Create a pull request from a worker branch to the integration branch. */
  async createPullRequest({ workerId, title, body, head = null, base = null } = {}) {
    if (!this.isConfigured) {
      return GitHubResult.err(new Error("GitHub not configured"));
    }

    const headBranch = head || this.getWorkerBranch(workerId);
    const baseBranch = base || this.getIntegrationBranch() || "main";
    if (!headBranch) {
      return GitHubResult.err(new Error("workerId or head branch required"));
    }

    const pr = await this._apiRequest(
      `/repos/${this.owner}/${this.repo}/pulls`,
      {
        method: "POST",
        body: {
          title: title || `Worker ${workerId} changes`,
          body: body || "",
          head: headBranch,
          base: baseBranch,
        },
      },
    );

    return GitHubResult.ok({
      pullRequest: pr.number,
      url: pr.html_url,
      head: headBranch,
      base: baseBranch,
    });
  }

  /** List pull requests for the integration branch. */
  async listPullRequests({ state = "open" } = {}) {
    if (!this.isConfigured) {
      return GitHubResult.err(new Error("GitHub not configured"));
    }

    const prs = await this._apiRequest(
      `/repos/${this.owner}/${this.repo}/pulls?state=${state}`,
    );
    return GitHubResult.ok({ pullRequests: prs });
  }

  /** Verify GitHub access and permissions. */
  async verifyAccess() {
    if (!this.token) {
      return GitHubResult.ok({
        authenticated: false,
        canCreateRepo: false,
        canPush: false,
        canCreatePR: false,
        error: "no token",
      });
    }

    try {
      const user = await this._apiRequest("/user");
      const canCreateRepo = Boolean(user.type === "User" || user.type === "Organization");

      return GitHubResult.ok({
        authenticated: true,
        login: user.login,
        canCreateRepo,
        canPush: true,
        canCreatePR: true,
      });
    } catch (err) {
      return GitHubResult.err(new Error(`GitHub access verification failed: ${err.message}`));
    }
  }

  /** Execute a local git command. */
  _git(args, options = {}) {
    const result = spawnSync("git", args, {
      encoding: "utf8",
      timeout: 30000,
      cwd: options.cwd || this._localRepo || process.cwd(),
      ...options,
    });
    return {
      code: result.status ?? -1,
      stdout: result.stdout ? result.stdout.toString() : "",
      stderr: result.stderr ? result.stderr.toString() : "",
    };
  }

  /** Clone a repository locally for isolated worker worktree. */
  async cloneLocally({ localPath, branch = "main" } = {}) {
    if (!this.isConfigured) {
      return GitHubResult.err(new Error("GitHub not configured"));
    }

    const repoUrl = `https://github.com/${this.owner}/${this.repo}.git`;
    const cloneResult = this._git(["clone", "--branch", branch, repoUrl, localPath], { timeout: 60000 });
    if (cloneResult.code !== 0) {
      return GitHubResult.err(new Error(`clone failed: ${cloneResult.stderr}`));
    }

    this._localRepo = localPath;
    return GitHubResult.ok({ path: localPath, branch });
  }

  /** Create an isolated worktree for a worker. */
  async createWorktree({ workerId, worktreePath, branch = null } = {}) {
    if (!this._localRepo) {
      return GitHubResult.err(new Error("no local repository — clone first"));
    }

    const targetBranch = branch || this.getWorkerBranch(workerId);
    if (!targetBranch) {
      return GitHubResult.err(new Error("workerId or branch required"));
    }

    const result = this._git(["worktree", "add", worktreePath, targetBranch], {
      cwd: this._localRepo,
    });
    if (result.code !== 0) {
      return GitHubResult.err(new Error(`worktree add failed: ${result.stderr}`));
    }

    return GitHubResult.ok({ workerId, path: worktreePath, branch: targetBranch });
  }

  /** Commit changes in a worker worktree. */
  async commitInWorktree({ worktreePath, files, message } = {}) {
    if (!this._localRepo) {
      return GitHubResult.err(new Error("no local repository"));
    }

    const addResult = this._git(["add", ...files], { cwd: worktreePath });
    if (addResult.code !== 0) {
      return GitHubResult.err(new Error(`git add failed: ${addResult.stderr}`));
    }

    const commitResult = this._git(["commit", "-m", message], { cwd: worktreePath });
    if (commitResult.code !== 0) {
      // Nothing to commit is not an error.
      if (commitResult.stderr.includes("nothing to commit")) {
        return GitHubResult.ok({ committed: false, message: "nothing to commit" });
      }
      return GitHubResult.err(new Error(`git commit failed: ${commitResult.stderr}`));
    }

    return GitHubResult.ok({ committed: true, message });
  }

  /** Push a worker branch to GitHub. */
  async pushBranch({ worktreePath, branch = null, workerId = null } = {}) {
    if (!this._localRepo) {
      return GitHubResult.err(new Error("no local repository"));
    }

    const targetBranch = branch || (workerId ? this.getWorkerBranch(workerId) : null);
    if (!targetBranch) {
      return GitHubResult.err(new Error("branch or workerId required"));
    }

    const pushResult = this._git(["push", "origin", targetBranch], { cwd: worktreePath });
    if (pushResult.code !== 0) {
      return GitHubResult.err(new Error(`git push failed: ${pushResult.stderr}`));
    }

    return GitHubResult.ok({ pushed: true, branch: targetBranch });
  }

  /** Get integration status: branches, PRs, merge readiness. */
  async getIntegrationStatus() {
    if (!this.isConfigured) {
      return GitHubResult.err(new Error("GitHub not configured"));
    }

    const [branchesResult, prsResult] = await Promise.allSettled([
      this._apiRequest(`/repos/${this.owner}/${this.repo}/branches`),
      this.listPullRequests({ state: "open" }),
    ]);

    const branches = branchesResult.status === "fulfilled" ? branchesResult.value : [];
    const prs = prsResult.status === "fulfilled" ? prsResult.value.pullRequests : [];

    const integrationBranch = this.getIntegrationBranch();
    const integrationExists = branches.some((b) => b.name === integrationBranch);

    return GitHubResult.ok({
      integrationBranch,
      integrationExists,
      branchCount: branches.length,
      openPullRequests: prs.length,
      pullRequests: prs.slice(0, 10),
    });
  }
}

export default { GitHubIntegration, GitHubResult };
