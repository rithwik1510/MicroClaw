# Persona Editor — Design Spec

**Date:** 2026-03-29
**Status:** Approved
**Scope:** Backend API + frontend page for editing agent personality files from the dashboard.

---

## Overview

Add a "Persona" tab to the dashboard sidebar that lets users view and edit all personality/identity markdown files (`groups/global/*.md`) directly from the UI. Changes apply immediately on the next message — no restart needed.

## Design Decisions

| Decision | Choice |
|----------|--------|
| Sidebar placement | First-class tab, between agent list and "New Chat" |
| Editing mode | Raw markdown (full control) |
| Files shown | All 7: SOUL, STYLE, IDENTITY, USER, TOOLS, MOPUS, HEARTBEAT |
| Scope | Global only (`groups/global/`). Per-agent overrides deferred. |
| Storage | Direct filesystem read/write. No database. |

---

## Layout

Small compact chip selectors in a row at the top. Editor opens below the active chip. Everything follows the existing dark theme.

```
[SOUL] [STYLE] [IDENTITY] [USER] [TOOLS] [MOPUS] [HEARTBEAT]

── SOUL.md ────────────────────────────────────── [Save]
┌────────────────────────────────────────────────────────┐
│                                                        │
│  Raw markdown editor (textarea)                        │
│  Full file content, editable                           │
│                                                        │
└────────────────────────────────────────────────────────┘
```

### UI Details (matching existing dashboard theme)

**Chip selectors:**
- Small rounded rectangles, `var(--bg-tertiary)` background, `var(--border)` border
- Filename only (SOUL, STYLE, etc.) in `var(--font-body)` at small size
- Active chip: `var(--accent)` border with `var(--accent-glow)` shadow
- Hover: `var(--bg-hover)` background
- Row wraps if needed, gap between chips
- Smooth transition on active state change

**Editor area:**
- Header row: filename in `var(--font-display)` serif font + Save button on the right
- Save button: `var(--accent)` background, same style as setup-btn
- Textarea: `var(--bg-tertiary)` background, `var(--border)` border, monospace font for markdown
- Textarea fills available height, min-height ~400px
- Focus state: orange glow border like the chat input
- Unsaved changes indicator (dot or subtle text) next to filename

**Animations:**
- Chips fade in staggered on page load (motion library)
- Editor content fades when switching between files
- Save button shows brief success state (checkmark or "Saved" text for 1.5s)

---

## API

### `GET /api/persona`

Returns all personality files with content.

```json
[
  { "filename": "SOUL.md", "content": "# SOUL.md — Who You Are\n\n..." },
  { "filename": "STYLE.md", "content": "# Style — How You Write\n\n..." },
  ...
]
```

Reads from `groups/global/`. Only returns `.md` files. Skips `memory/` subdirectory.

### `PUT /api/persona/:filename`

Saves updated content to a file.

**Request:** `{ "content": "# SOUL.md — Who You Are\n\n..." }`
**Response:** `{ "ok": true }`

**Validation:**
- Filename must be one of: `SOUL.md`, `STYLE.md`, `IDENTITY.md`, `USER.md`, `TOOLS.md`, `MOPUS.md`, `HEARTBEAT.md`
- No path traversal (reject `../`, absolute paths, etc.)
- Content must be a string, max 50KB

---

## Files

### New
| File | Purpose |
|------|---------|
| `server/api/persona.ts` | GET/PUT endpoints for personality files |
| `ui/src/PersonaPage.tsx` | Persona editor page component |

### Modified
| File | Change |
|------|--------|
| `server/index.ts` | Mount persona router |
| `ui/src/Dashboard.tsx` | Add Persona tab to sidebar, route to PersonaPage |
| `ui/src/styles.css` | Add persona page styles |
| `ui/src/api.ts` | Add getPersonaFiles / savePersonaFile functions |

---

## Implementation Order

1. Backend API (`server/api/persona.ts`) — read/write md files
2. Frontend API client (`ui/src/api.ts`) — fetch/save functions
3. PersonaPage component (`ui/src/PersonaPage.tsx`) — chips + editor
4. Wire into Dashboard sidebar + styles
5. Build and test
