# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in agents-cli, please report it
responsibly via GitHub Security Advisories:

**https://github.com/phnx-labs/agi-cli/security/advisories/new**

This opens a private channel with the maintainers. Please include:

- A description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We will acknowledge receipt within 48 hours and aim to release a fix within
7 days for critical issues.

**Fallback:** If you cannot use GitHub Security Advisories, email
`security@phnx-labs.com`.

## Scope

agents-cli runs locally and manages agent CLI binaries, config files, and credentials on your machine. Security-sensitive areas include:

- **Keychain integration** (`cli/src/lib/secrets/`) -- stores API keys in the macOS Keychain
- **Shim scripts** (`cli/src/lib/installations/shims.ts`) -- generated shell scripts that route agent commands
- **Cloud dispatch** (`cli/src/lib/cloud/`) -- sends prompts to remote providers via authenticated APIs
- **PTY server** (`cli/src/lib/pty-server.ts`) -- Unix socket server for terminal session management

## Supported Versions

We release security fixes for the latest minor version only. Upgrade to the latest version to receive patches.
