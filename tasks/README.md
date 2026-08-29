# Benchmark tasks

One JSON file per task (see `src/tasks.ts` for the schema). Start with 5–10
curated issues on repos you control; SWE-bench Lite rows map onto the same
shape (`repo`, `base_commit`, `problem_statement`, `FAIL_TO_PASS` → `evaluation_command`).

`evaluation_command` is the hidden oracle: it runs after the agents are done
and is the only thing `success` is computed from. Keep it out of the prompt.
