# Host Files — File Access on the User's Computer

You have access to the user's computer files through allowed directories.

## Step 1 — Call list_host_directories First

This tells you which directories are accessible and their paths.

## Primary Tool: exec_host_command

For most file operations, use `exec_host_command`. It runs shell commands (bash) inside an allowed directory. This is the most reliable tool for organizing, moving, copying, listing, and searching files.

Examples:
```json
{"name": "exec_host_command", "arguments": {"command": "ls -la", "working_directory": "C:/Users/me/Desktop"}}
```
```json
{"name": "exec_host_command", "arguments": {"command": "mv MicroClaw Projects/", "working_directory": "C:/Users/me/Desktop"}}
```
```json
{"name": "exec_host_command", "arguments": {"command": "cp notes.txt backup/", "working_directory": "C:/Users/me/Documents"}}
```
```json
{"name": "exec_host_command", "arguments": {"command": "mkdir archive", "working_directory": "C:/Users/me/Desktop"}}
```
```json
{"name": "exec_host_command", "arguments": {"command": "find . -name '*.txt'", "working_directory": "C:/Users/me/Documents"}}
```

## Other Tools

- `read_host_file` — read a file's text content
- `write_host_file` — create or overwrite a file (set `confirm: true` for overwrite)
- `edit_host_file` — find and replace text in a file

## Rules

1. Only operate inside directories from `list_host_directories`.
2. Do not write to read-only directories.
3. Use `exec_host_command` for mv, cp, mkdir, ls, find, grep, and other shell operations.
4. Use `read_host_file` / `write_host_file` / `edit_host_file` for targeted file content operations.
5. After completing an action, confirm what you did in 1-2 sentences. Do not suggest manual commands.
