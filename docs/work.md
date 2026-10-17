# Configured workers

Every worker in `templates` is directly available to Kaeno. There is no root or
preferred worker selector: defining a template makes it a choice for the main
assistant, regardless of other workers' delegation lists.

The CLI currently loads worker definitions from the file named by
`KAENO_WORK_CONFIG` (locally, `work-config.json`). Kaeno's own model and
instructions remain in `KAENO_CONFIG` (`config.json`). For example:

```json
{
  "maxDepth": 2,
  "templates": {
    "easy": {
      "description": "Simple, well-scoped tasks",
      "model": "openrouter/openai/gpt-6-luna",
      "instructions": "Complete the brief and verify the result.",
      "delegates": [],
      "skills": []
    },
    "high": {
      "description": "Difficult tasks requiring deeper reasoning",
      "model": "openrouter/openai/gpt-6.1-sol",
      "instructions": "Complete the brief carefully and report evidence.",
      "delegates": ["easy"],
      "skills": []
    }
  }
}
```

- Kaeno can start either `easy` or `high` directly.
- `high` can additionally start an `easy` child worker.
- `easy` cannot start child workers.
- `maxDepth` limits worker nesting; it does not hide templates from Kaeno.
- `skills` must currently be empty for the local Docker extension.

The old top-level `"agent"` setting is removed and rejected by validation. The
`agent` argument of `start_work` still names the worker chosen for that particular
task. Running work retains its frozen blueprint and child-delegation policy.

Restart Kaeno after editing configuration. Existing conversations retain their
saved instructions; start a new Pi session with `/new` to get the current worker
listing in a fresh Kaeno conversation.
