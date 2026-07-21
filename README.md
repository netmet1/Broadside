# Broadside

Windows desktop application for opening many concurrent SSH sessions to Linux
hosts and broadcasting commands across them simultaneously.

Built with Tauri 2 + Rust + React + TypeScript.

## Status

**v1.1.0**

## Local development

Prerequisites:

- Rust (stable, 1.95+)
- Node.js 20+ and npm
- Windows SDK (WebView2 is auto-installed by the Tauri bootstrapper)

Install and run:

```powershell
npm install
npm run tauri dev
```

Scripts:

- `npm run dev` &mdash; Vite frontend only (rarely useful without Tauri)
- `npm run tauri dev` &mdash; full app in dev mode
- `npm run typecheck` &mdash; `tsc -b`
- `npm run lint` &mdash; ESLint
- `npm run build` &mdash; production frontend build (Tauri bundle is a separate step)

## License

Proprietary. All rights reserved. See [`NOTICE.md`](./NOTICE.md).
