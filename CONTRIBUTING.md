# Contributing

Thanks for helping improve Looking Glass.

## Development setup

Looking Glass supports Linux and native Windows. Use Node.js 22.19.0 or newer,
npm, and `ripgrep` (`rg` on Linux or `rg.exe` on Windows) on `PATH`. On
Windows, run the commands below from PowerShell:

```text
npm ci
npm run typecheck
npm test
npm run build
```

Keep changes focused, add or update tests for behavior changes, and explain
user-visible changes in the pull request. Do not commit credentials, local
configuration, SQLite state, artifacts, build output, or provider endpoints
that are not suitable for public documentation. Looking Glass is not a
sandbox: it runs with the operating-system permissions of the current user.
On Windows, keep configuration and state under the user's profile with the
default profile ACLs; do not put them on shared or UNC paths. Scheduled and
shell commands use noninteractive PowerShell on Windows, and remembered
PowerShell approvals are exact command, working-directory, and timeout matches.

## Pull requests

Open a pull request against `main` with a concise description of the problem,
the approach taken, and validation performed. Please report security issues
privately as described in [SECURITY.md](./SECURITY.md) rather than opening a
public issue.