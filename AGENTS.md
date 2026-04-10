# NanoClaw Guidelines

- Treat OpenClaw as a reference, not a blueprint. Check how it solves a problem when we are unsure, then adapt only the parts that fit NanoClaw.
- Prefer the simplest NanoClaw-native design over feature copying. Build for our runtime, our workflow, and our maintenance cost.
- Do not stack multiple scraping systems for the same job. One primary path plus one clear fallback is enough.
- Avoid mixing overlapping web approaches unless there is a proven gap. Extra layers add bugs, drift, and harder debugging.
- When adding a new capability, decide the ideal end-state first, then implement toward that instead of patching tools together.
- Keep this file short. Only update it when explicitly asked.
