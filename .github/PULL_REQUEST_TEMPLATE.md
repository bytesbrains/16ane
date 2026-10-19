## Summary

<!-- What changes and why. -->

Closes #

## Traceability

- Requirements: <!-- REQ-xxx -->
- Decisions: <!-- ADR-xxxx -->

## Checklist

- [ ] `make test` passes locally (contracts, TS SDK, Python SDK, E2E)
- [ ] `make fmt-check` and `make lint` pass
- [ ] Negative/adversarial tests added for contract or SDK behaviour changes (`docs/security/THREAT_MODEL.md`)
- [ ] No private keys, mnemonics or secrets in source, tests, logs or fixtures
- [ ] `tANE` is not described as ₹-backed, redeemable, investable or convertible to `ANE`
- [ ] Spend limits remain contract-enforced; revenue does not raise spend authority in `FIXED` mode
- [ ] Docs updated where behaviour or interfaces changed
