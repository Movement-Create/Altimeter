# Altimeter Tools

| Tool Name | Permission Level | Description |
|---|---|---|
| agent | agent | Spawn a subagent to complete a subtask. The subagent gets a fresh context and returns only its final answer. Use for parallel work, context isolation, or specialized roles. |
| bash | execute | Execute a shell command and return stdout+stderr. Use for running scripts, build tools, tests, package managers, etc. |
| file_edit | write | Surgically replace a string in a file. More reliable than rewriting whole files. Fails if the old_string is not found or appears multiple times (use replace_all=true for the latter). |
| file_read | read | Read a file's contents, or list a directory. Supports line offset/limit for large files. |
| file_write | write | Write content to a file. Creates parent directories automatically. Can append to existing files. |
| glob | read | Find files matching a glob pattern. Returns a list of matching file paths. |
| grep | read | Search file contents with a regex pattern. Returns matching lines with context. Searches recursively in directories. |
| todo_write | write | Create or update the task list. Pass the COMPLETE list on every call — this replaces the current list. Use this to track multi-step work and show progress. |
| web_fetch | network | Fetch a URL and return its text content. HTML is automatically converted to readable text. Use prompt parameter to extract specific information. |
| web_search | network | Search the web and return a list of relevant results with titles, URLs, and snippets. |