# Future INR-backed ANE: institutional and regulatory research track

> **Research notes only. NOT legal advice, NOT an offer, and NOT a plan to issue.** No INR is accepted, no real-value `ANE` exists, no financial institution has been engaged, and nothing here implies regulatory approval. Every regulatory point below is an **open question for qualified Indian counsel**. The public `tANE` sandbox is free, has no value, and does not depend on any item in this document. Mainnet blockers are tracked in [#35](https://github.com/bytesbrains/16ane/issues/35).

## Concept under research
A depositor would pay ₹1 through an authorized channel; after settlement and eligibility checks, an issuer would mint 16 ANE to a designated wallet, and authorized redemption would burn 16 ANE against a ₹1 payout obligation. Whether any of this is permissible, and under whose licence, is unknown. Fees, minimum redemption, settlement time, identity requirements, restrictions and reserve composition would all depend on legal and banking arrangements that do not exist.

## Institutional architecture options to research
- Licensed bank/payment institution as issuer or distribution partner.
- Ring-fenced INR reserves at qualified custodians with independent audit/attestation.
- Authorized mint/burn controller, segregated issuer duties and emergency procedures.
- Redemption queue with recoverable states for payout failure and on-chain reorgs.
- On-chain transparency of supply, mint/burn, liabilities; off-chain third-party evidence for reserves.
- AML/CFT, sanctions, KYC, tax, data protection, FX and cross-border access obligations as applicable.

## Regulatory landscape snapshot (checked 2026-10-19)
Facts as reported by the cited sources. Their legal effect on 16ane is an open question for counsel. Items marked *(secondary)* come from law-firm or press summaries, not the primary text.

- **RBI position on crypto and stablecoins.** On 2 July 2026 the RBI told a parliamentary panel that virtual digital assets should not be legalised. Reporting on internal RBI documents (8–9 July 2026) describes opposition to bank crypto exposure and to both foreign-currency and **rupee-pegged stablecoins**. The RBI's June 2026 Financial Stability Report notes the US GENIUS Act, EU MiCA and UK rules, and continues to favour the e-rupee (CBDC). A government crypto discussion paper has been repeatedly delayed. *(secondary)*
- **Income-tax Act, 2025.** It replaced the Income-tax Act, 1961 from **1 April 2026** (assent 21 August 2025; Income-tax Rules, 2026 notified 20 March 2026). Section numbers have changed. The 1% TDS on VDA transfers (formerly s.194S) is reported under **s.393(1)** of the 2025 Act *(secondary)*. The successor to the 30% VDA income tax (formerly s.115BBH) and the VDA definition (formerly s.2(47A)) must be confirmed against the enacted text.
- **Crypto-asset reporting.** From 1 April 2026 the VDA definition was reported to expressly cover crypto-assets, alongside new crypto-asset information reporting (OECD CARF); the Income-tax (Amendment) Rules, 2026 (5 March 2026) implement CRS/CARF reporting. *(secondary)*
- **Payment regulation.** The RBI (Regulation of Payment Aggregators) Directions, 2025 (15 September 2025) cover online, physical and cross-border aggregators, with fresh authorisation for non-bank players *(secondary)*. The PPI Master Direction (2021, updated to 27 December 2024) is proposed to be replaced by a **draft Master Direction on PPIs, 2026** (comments closed 22 May 2026; final status unconfirmed).
- **AML/CFT.** VDA service providers serving India must register with FIU-IND as PMLA reporting entities whether or not they are located in India; FIU-IND updated its VDA AML/CFT guidelines on 8 January 2026 and issued notices to 15 unregistered VDA SPs on 9 September 2026. *(secondary, apart from the PIB/AIR release)*
- **Data protection.** The DPDP Rules, 2025 were notified on 14 November 2025, with obligations phasing in until about **May 2027**.
- **Outside India.** The US GENIUS Act (signed 18 July 2025) sets conditions for foreign payment-stablecoin issuers serving the US; the EU applies MiCA. Any offering reachable from those markets would need its own analysis.

## Required questions for Indian legal counsel and prospective institution
1. Given the RBI's reported opposition to rupee-pegged stablecoins (July 2026), is issuance of a transferable INR-referenced token permissible at all under current RBI rules? If so, under what licence or partner structure?
2. Could token issuance, redemption or payment constitute a regulated payment system, prepaid payment instrument (2021 MD or the 2026 draft), payment aggregation (2025 PA Directions), deposit-taking, virtual digital asset activity, or another regulated activity?
3. Which entity is legal issuer and liable to redeem? Who owns the reserves? What happens in insolvency?
4. Are domestic peer-to-peer transfers, agent-to-agent micropayments and cross-border transfers allowed? With which restrictions (FEMA, PA-CB)?
5. How do the Income-tax Act, 2025 VDA provisions (30% tax, 1% TDS reported under s.393, crypto-asset reporting), GST, AML reporting and customer identification apply to mint, transfer and redeem — in particular to high-frequency, low-value agent-to-agent payments where per-transfer TDS may be operationally infeasible?
6. Would 16ane, a facilitator operator, or a merchant need FIU-IND registration as a VDA service provider, and from which activity onward?
7. What reserve instruments, audit cadence, segregation and consumer disclosures are required?
8. Which financial institutions are willing and permitted to support such a pilot?
9. What DPDP Act/Rules obligations apply to wallet, KYC and payment data, and on what timeline?

## Evidence needed for institutional conversations
Public sandbox demo, independent security report, source verification, governance chart, reserve accounting model, risk register, projected transaction patterns, abuse controls, redemption state machine, legal memorandum, financial institution letters and regulatory correspondence. No presumption of approval.

## Testnet sandbox position
The `tANE` sandbox is not blocked on any question above: tANE is unbacked, free from the faucet, never sold, never redeemed and never convertible. Keeping it that way is what keeps it outside this track. Reassess with counsel if any of these change:
- a third party lists, sells or pools tANE so it acquires a market price;
- 16ane offers any fiat on-ramp, off-ramp, paid credit or exchange involving tANE;
- the hosted sandbox starts collecting personal data beyond salted IP hashes and wallet addresses (DPDP notice and retention then need review).

## Hard boundary
Never bridge tANE into real ANE or promise future exchange. Keep testnet faucet tokens legally and technically separate from future reserves. Do not use 'stablecoin' or 'rupee-backed' to describe tANE.

## Sources (checked 2026-10-19)
- Income-tax Act, 2025 in force from 1 April 2026: [Income Tax Department press release](https://www.incometaxindia.gov.in/documents/d/guest/press-release-income-tax-act-2025-comes-into-force-from-01-april-2026-pdf); [All India Radio, 22 Aug 2025](https://www.newsonair.gov.in/income-tax-act-2025-gets-presidents-assent-will-be-effective-from-1st-april-2026)
- VDA TDS under s.393: [TDSMAN, Aug 2026](https://blog.tdsman.com/2026/08/tds-on-virtual-digital-assets-section-3931-194s/); [CAclubindia](https://www.caclubindia.com/news/tds-on-virtual-digital-assets-under-income-tax-act-2025-key-rules-rate-threshold-and-compliance-26748.asp)
- Crypto-asset reporting / CARF: [CAclubindia](https://www.caclubindia.com/news/income-tax-act-amendment-new-reporting-norms-for-crypto-assets-effective-april-2026-24499.asp); [IndiaLaw, Income-tax (Amendment) Rules 2026](https://www.indialaw.in/blog/regulatory/income-tax-amendment-rules-2026/)
- RBI stance: [Cryptowire](https://www.cryptowire.in/blog/rbi-doubles-down-on-crypto-prohibition-as-parliamentary-panel-report-nears/); [CryptoTimes, 1 Jul 2026](https://www.cryptotimes.io/2026/07/01/from-genius-act-to-mica-indias-rbi-notes-global-regulatory-steps-on-stablecoins/); [CryptoTimes, 1 Apr 2026](https://www.cryptotimes.io/2026/04/01/indias-crypto-policy-delayed-again-as-rbi-blocks-discussion-paper/); [Lexology, India Digital Assets Round-Up](https://www.lexology.com/library/detail.aspx?g=8f9ef620-1f6b-40eb-9b3d-0256f353c183)
- Payments: [RBI Master Directions index](https://website.rbi.org.in/web/rbi/payment-and-settlements/master-directions); [RBI PPI MD (updated 27 Dec 2024)](https://website.rbi.org.in/documents/87730/39710850/82MDPPIS_UpdatedasonDecember272024.pdf); [Inc42 on PA Directions 2025](https://inc42.com/?p=531658); [Fox Mandal on draft PPI MD 2026](https://foxmandal.in/news/rbi-issues-draft-master-direction-on-prepaid-payment-instruments/)
- FIU-IND: [All India Radio, 9 Sep 2026](https://newsonair.gov.in/fiu-ind-cracks-down-on-15-vda-service-providers-over-pmla-non-compliance/); [Tsaaro on 2026 guidelines](https://tsaaro.com/blogs/india-s-2026-aml-cft-guidelines-for-virtual-digital-assets-what-changed)
- DPDP Rules: [PIB explainer](https://static.pib.gov.in/WriteReadData/specificdocs/documents/2025/nov/doc20251117695301.pdf); [AZB & Partners](https://www.azbpartners.com/bank/indias-digital-personal-data-protection-act-phased-rollout-and-key-compliance-milestones/)
- GENIUS Act: [Congressional Research Service IN12553](https://www.everycrsreport.com/files/2026-08-20_IN12553_0b329134f6be0cc12f78017358552f4053d52c5e.html); [Covington](https://www.cov.com/en/news-and-insights/insights/2025/07/the-genius-act-becomes-law-key-provisions-from-the-federal-stablecoin-regulatory-framework)

**Limitations:** I did not read the primary texts of the Income-tax Act, 2025, the PA Directions 2025, the draft PPI MD 2026 or the FIU-IND 2026 guidelines; they were checked through the summaries above. Status after mid-2026 (parliamentary committee report, final PPI MD) was not found. Re-verify before any institutional conversation.
