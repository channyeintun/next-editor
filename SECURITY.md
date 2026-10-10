# Security policy

## Reporting a vulnerability

Please report security issues privately by email to **chanyeintun@gmail.com**. Do not open a public issue or pull request for a vulnerability.

Include what you can of:

- the affected URL, route or file, and the commit or date you tested;
- steps to reproduce, or a proof of concept;
- the impact you expect (for example, whose data is exposed or what an attacker gains).

Automated reports from [Anthropic's OSS Scanner](https://github.com/anthropics/oss-scanner) go to the same address.

## Supported versions

Security fixes go to the `main` branch, which is what runs at https://nexteditor.dev. Older commits and self-hosted copies are not patched separately.

## Scope

[`.oss-scanner/threat_model.md`](.oss-scanner/threat_model.md) describes where untrusted input enters, which components matter most, and how severity is rated. Third-party services the app calls (the language playgrounds, OpenRouter, Google, Cloudflare, WebContainer) are out of scope; report issues in them to their owners.
