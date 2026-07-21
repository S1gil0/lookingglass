# Security policy

Looking Glass is a local automation tool, not a sandbox. It runs local commands
with the operating-system permissions of the user who launches it. Review the
approval mode and workspace before allowing automation to run. On Windows,
configuration and state use the current user's profile and its default ACLs;
avoid shared folders and UNC paths for these files. Scheduled and shell
commands run through noninteractive PowerShell, and remembered PowerShell
approvals match the exact command, working directory, and timeout.

## Reporting a vulnerability

Do not include credentials, private transcripts, or exploit details in a public
issue. Use GitHub's private vulnerability reporting for this repository when
available. If it is not enabled, contact a repository maintainer through
GitHub to arrange a private report. Please do not use public issues or pull
requests for vulnerabilities.

Please include the affected version, platform, reproduction steps, impact, and
any suggested mitigation. Remove or rotate exposed credentials immediately.