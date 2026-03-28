# Host Files — Local File Access Tools

You have tools to read, write, edit, search, and organize files on the user's computer.

## Step 1 — Always Do This First

Call `list_host_directories` (no arguments needed) to see which directories you can access.

Example tool call:
```json
{"name": "list_host_directories", "arguments": {}}
```

This returns the allowed paths, their access mode (read-only or read-write), and a preview of contents.

If it returns "No host directories configured", tell the user to run `/add-host-files`.

## Available Tools

### Reading
- `list_host_entries` — list files in a folder
  ```json
  {"name": "list_host_entries", "arguments": {"path": "C:/Users/me/Documents"}}
  ```
- `read_host_file` — read a file
  ```json
  {"name": "read_host_file", "arguments": {"path": "C:/Users/me/Documents/notes.txt"}}
  ```
- `glob_host_files` — find files by pattern
  ```json
  {"name": "glob_host_files", "arguments": {"base_path": "C:/Users/me/Documents", "pattern": "**/*.md"}}
  ```
- `grep_host_files` — search text in files
  ```json
  {"name": "grep_host_files", "arguments": {"base_path": "C:/Users/me/Documents", "query": "TODO"}}
  ```

### Writing
- `write_host_file` — create a new file
  ```json
  {"name": "write_host_file", "arguments": {"path": "C:/Users/me/Documents/new.txt", "content": "Hello world"}}
  ```
- `write_host_file` — overwrite existing (needs user confirmation first)
  ```json
  {"name": "write_host_file", "arguments": {"path": "C:/Users/me/Documents/old.txt", "content": "Updated", "mode": "overwrite", "confirm": true}}
  ```
- `edit_host_file` — find and replace in a file
  ```json
  {"name": "edit_host_file", "arguments": {"path": "C:/Users/me/Documents/notes.txt", "search": "old text", "replace": "new text"}}
  ```

### Organizing
- `make_host_directory` — create a folder
  ```json
  {"name": "make_host_directory", "arguments": {"path": "C:/Users/me/Documents/archive"}}
  ```
- `move_host_path` — move or rename
  ```json
  {"name": "move_host_path", "arguments": {"source_path": "C:/Users/me/Documents/old.txt", "destination_path": "C:/Users/me/Documents/archive/old.txt"}}
  ```
- `copy_host_path` — copy
  ```json
  {"name": "copy_host_path", "arguments": {"source_path": "C:/Users/me/Documents/notes.txt", "destination_path": "C:/Users/me/Desktop/notes-backup.txt"}}
  ```

## Rules

1. Only use paths inside directories returned by `list_host_directories`.
2. Do not write to read-only directories.
3. Always use absolute paths (e.g. `C:/Users/me/Documents/file.txt`).
4. Before overwriting, ask the user to confirm. Then set `"confirm": true`.
5. When the user asks to do something with files, USE THE TOOLS. Do not just describe what you would do.
