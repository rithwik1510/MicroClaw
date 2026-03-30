# /add-host-files - Configure Native Host File Access

This skill configures NanoClaw to access selected folders on the user's computer while staying within an explicit allowlist.

## What It Does

1. Writes `~/.config/microclaw/host-directories.json`
2. Ensures NanoClaw runs with `NANOCLAW_EXECUTION_BACKEND=native`
3. Makes the agent discover allowed folders through `list_host_directories`

## Quick Setup

```powershell
npx tsx scripts/setup-host-files.ts --paths "~/Documents,~/Desktop,~/projects" --backend native
cd container/agent-runner
npm run build
cd ../..
npm run dev
```

## Ask First

- Which folders should be accessible?
- Should they be read-only or read-write?
- What kind of work will the agent do there?

Common choices:
- `~/Documents`
- `~/Desktop`
- `~/Downloads`
- `~/OneDrive`
- a specific project folder

## Notes

- Windows paths like `C:/Users/posan/Documents` work too.
- `--readonly` makes every configured folder read-only.
- `--dry-run` previews the change without writing it.
- After setup, verify from Discord by asking the bot to list files. It should use `list_host_directories`.

## If Verification Fails

Check:
- `~/.config/microclaw/host-directories.json` exists and contains the expected paths
- `container/agent-runner/dist` was rebuilt
- NanoClaw was restarted after the change
