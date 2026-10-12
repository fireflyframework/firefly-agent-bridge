# Upstream license sources

These are original upstream notices, not Signature-authored source files.

- `node.txt`: the complete LICENSE distributed with official Node.js 26.3.0, including bundled dependencies. Retrieved from the verified Node distribution.
- `abstract-logging.txt`: the MIT license linked by abstract-logging 2.0.1 at [the author's license page](https://jsumners.mit-license.org/). That npm package links its license rather than including a LICENSE file.

The build collects the actual bundled npm packages' full license and notice files into `dist/THIRD_PARTY_NOTICES.txt` and appends the Node runtime notices. The native archives and Desktop extensions distribute that file alongside LICENSE and NOTICE.

- `mcpb-manifest-v0.3.schema.json`: unmodified official MCPB 0.3 manifest schema from Anthropic MCPB 2.1.2. Its original license is preserved in `mcpb-schema.txt`. Used only to validate private desktop packaging.
