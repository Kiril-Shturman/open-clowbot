# LEARNINGS

## [LRN-20260309-001] correction

**Logged**: 2026-03-09T03:31:00+02:00
**Priority**: high
**Status**: pending
**Area**: docs

### Summary
User prefers autonomous execution with an internal todo plan instead of step-by-step permission checks.

### Details
User explicitly asked why every small step is being asked and requested to create a todo list and execute by it. For technical implementation tasks, default behavior should be: execute in batches, report milestones, ask only for risky/irreversible/external actions.

### Suggested Action
Adopt "milestone updates" mode by default for this user: silently execute safe steps, send compact progress checkpoints, and request approval only when required by safety rules.

### Metadata
- Source: user_feedback
- Related Files: AGENTS.md
- Tags: workflow, autonomy, communication

---
