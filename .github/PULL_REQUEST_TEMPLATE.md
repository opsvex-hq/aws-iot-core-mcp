## What this changes

<!-- One or two sentences. -->

## Why

<!-- The operational question it answers, or the bug it fixes. -->

## How it was tested

<!-- Be specific. "Ran against 40 gateways in sa-east-1" is worth more than a
     paragraph of description. If it was only tested against the fakes, say so. -->

## Checklist

- [ ] `npm run verify` passes
- [ ] No new dependency (or the PR argues for it)
- [ ] Any new tool declares `annotations: READ_ONLY` and depends only on the ports
- [ ] Device-authored values go through `sanitizeUntrusted` + `fenceUntrusted`
- [ ] New behaviour has a test; new tool is documented in `docs/TOOLS.md`
- [ ] This PR adds **no** way to write to AWS (see ADR 0002)
