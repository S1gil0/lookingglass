# Contributing

Thanks for helping improve Looking Glass.

## Development setup

Looking Glass requires Linux, Node.js 22 or newer, npm, and `ripgrep`.

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Keep changes focused, add or update tests for behavior changes, and explain
user-visible changes in the pull request. Do not commit credentials, local
configuration, SQLite state, artifacts, build output, or provider endpoints
that are not suitable for public documentation.

## Pull requests

Open a pull request against `main` with a concise description of the problem,
the approach taken, and validation performed. Please report security issues
privately as described in [SECURITY.md](./SECURITY.md) rather than opening a
public issue.