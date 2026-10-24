# Light Fingers

A heist puzzler starring Mr. Locke. TypeScript + Three.js + Vite, built on a vendored `@slu/web-shell` (`vendor/slu-web-shell`).

```bash
npm i && npm run dev      # play
npm run verify            # typecheck + sim tests + build
```

- `?editor`: dev room editor (place, drag, edit, export JSON). `?room=<id>` loads a room from `src/rooms/`.
- Music stems: add files to `public/audio/<venue>/` and list them in `src/audio/stems.ts`. Anything without a stem falls back to the procedural swing bed.
- Controls: WASD move, Space stretch, C crouch, F flatten, Click/Enter use, Q/E rotate, T rewind, R restart, Esc pause. Gamepad and touch controls work too.
