# Inherited Upstream Tags

AgentFlow is a fork of [decolua/9router](https://github.com/decolua/9router).
When this repository was created, upstream's tag namespace came with it. As a
result the repo carries **91 tags**, of which exactly **one** — `v0.2.0` — is an
AgentFlow release tag. The other **90 are inherited** from upstream and do not
correspond to any AgentFlow release.

## The two namespaces

| Namespace | Tags | Meaning |
| --- | --- | --- |
| AgentFlow | `v0.2.0` | The only tag AgentFlow created. Points at the AgentFlow release commit. |
| Inherited (9Router) | `v0.2.21` … `v0.5.95` | Upstream 9Router tags that arrived with the fork history. Not AgentFlow releases. |

## Inherited tag distribution

| Line | Count |
| --- | --- |
| `v0.2.x` | 12 |
| `v0.3.x` | 14 |
| `v0.4.x` | 40 |
| `v0.5.x` | 24 |
| **Total** | **90** |

The inherited series spans upstream commits dated 2026-01-12 through
2026-10-01.

## Why they are kept

- **Provenance.** `AUDIT/` and `PROJECT_ORIGIN.md` reconstruct which upstream
  revisions this fork derives from. The tags are part of that trail.
- **Pinpoints.** A future provenance audit may need to diff AgentFlow against a
  specific upstream release. The tag is the cheapest pointer to it.
- **Non-interference.** They cost nothing at rest and cause no ambiguity in
  practice: GitHub Releases lists only `v0.2.0`, because tags without a release
  object do not appear there.

## Do not delete

These tags are **not to be deleted**. Deleting them would:

1. Break provenance references in `AUDIT/` and `PROJECT_ORIGIN.md`.
2. Require a force-push of the tag namespace (history rewrite).
3. Lose the only in-repo anchors to specific upstream releases.

If the namespace ever needs cleaning, do it against a fork or a mirror — never
by rewriting refs on the canonical repository.
