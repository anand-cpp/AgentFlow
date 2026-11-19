// GitHub integration tests.
//
// Tests the parts of GitHubIntegration that don't require network access:
// configuration, branch naming, and integration status structure.
// Network-dependent methods (repository creation, PRs, pushes) are
// exercised through the CLI and require a real GitHub token.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GitHubIntegration } from "../../../src/core/hackathon/github.js";

describe("GitHubIntegration", () => {
  it("reports unconfigured when no token", () => {
    const gh = new GitHubIntegration();
    assert.strictEqual(gh.isConfigured, false);
  });

  it("reports configured with token, owner, repo", () => {
    const gh = new GitHubIntegration({
      token: "ghp_test123",
      owner: "test-owner",
      repo: "test-repo",
      sessionId: "hk-session-1",
    });
    assert.strictEqual(gh.isConfigured, true);
    assert.strictEqual(gh.owner, "test-owner");
    assert.strictEqual(gh.repo, "test-repo");
    assert.strictEqual(gh.sessionId, "hk-session-1");
  });

  it("generates integration branch name", () => {
    const gh = new GitHubIntegration({
      token: "t", owner: "o", repo: "r", sessionId: "hk-abc123",
    });
    const branch = gh.getIntegrationBranch();
    assert.strictEqual(branch, "hackathon/hk-abc123/integration");
  });

  it("generates worker branch names", () => {
    const gh = new GitHubIntegration({
      token: "t", owner: "o", repo: "r", sessionId: "hk-abc123",
    });

    const b1 = gh.getWorkerBranch("worker-1");
    const b2 = gh.getWorkerBranch("worker-2");
    const b3 = gh.getWorkerBranch("worker-1"); // same worker, same branch

    assert.strictEqual(b1, "hackathon/hk-abc123/worker-worker-1");
    assert.strictEqual(b2, "hackathon/hk-abc123/worker-worker-2");
    assert.strictEqual(b3, b1); // cached
  });

  it("returns null for worker branch without sessionId", () => {
    const gh = new GitHubIntegration({ token: "t", owner: "o", repo: "r" });
    assert.strictEqual(gh.getWorkerBranch("worker-1"), null);
  });

  it("verifyAccess fails without token", async () => {
    const gh = new GitHubIntegration();
    const result = await gh.verifyAccess();
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data.authenticated, false);
    assert.strictEqual(result.data.canCreateRepo, false);
  });
});
