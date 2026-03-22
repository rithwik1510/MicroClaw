# Host Files - Access & Manage the User's Computer Files

You are running in native mode on the user's computer. For local file tasks, use the native host-file tools and the real host paths they return.

## First Step

Always call `list_host_directories` first unless this conversation already contains a confirmed allowed path from that tool.

That tool tells you:
- which directories are available
- whether each directory is read-only or read-write
- what each directory currently contains

If no directories are configured, explain that host-file access has not been set up yet.

## Core Tools

- `list_host_directories`
- `list_host_entries`
- `read_host_file`
- `write_host_file`
- `edit_host_file`
- `glob_host_files`
- `grep_host_files`
- `make_host_directory`
- `move_host_path`
- `copy_host_path`

Prefer these structured tools over shell commands for file work.

## Rules

- Stay strictly inside the directories returned by `list_host_directories`.
- Respect read-only roots.
- Require explicit confirmation before overwriting, replacing, or moving content in a way that could destroy existing data.
- Use the exact real paths returned by the tools.
- On Windows, prefer forward slashes when you mention paths.
- Do not browse unrelated parts of the filesystem.

## Common Patterns

### List files in a folder
1. Call `list_host_directories`
2. Call `list_host_entries` on the chosen allowed path

### Read a file
1. Discover the allowed root
2. Use `list_host_entries` or `glob_host_files` to locate the file
3. Use `read_host_file`

### Create or edit a file
1. Confirm the target path is inside an allowed writable root
2. Use `write_host_file` for new files
3. Use `edit_host_file` for targeted changes

### Organize a folder
1. Inspect with `list_host_entries`
2. Propose the plan clearly
3. After confirmation, use `make_host_directory`, `move_host_path`, and `copy_host_path`
