/** Shared legal policy copy. Unconfigured installs render Draft; hosted publication binds effective metadata separately. */
export type LegalLinkPart = string | { label: string; href: string };

export type LegalBlock =
  | { type: 'paragraph'; text: string }
  | { type: 'linkedParagraph'; parts: readonly LegalLinkPart[] }
  | { type: 'list'; items: readonly string[] }
  | { type: 'table'; columns: readonly string[]; rows: readonly (readonly string[])[] };

export interface LegalPolicy {
  slug: 'terms' | 'privacy' | 'data-processing' | 'subprocessors';
  navigationLabel: string;
  title: string;
  description: string;
  reviewDate: string;
  introduction?: string;
  sections: readonly {
    id: string;
    title: string;
    blocks: readonly LegalBlock[];
  }[];
}

export const legalDraftNotice =
  'Draft for review — not yet effective. These proposed policies have not been adopted.';

export const termsPolicy = {
  slug: 'terms',
  navigationLabel: 'Terms draft',
  title: 'OpenGen Terms of Service',
  description:
    'Proposed OpenGen Terms of Service, including prepaid credit and refund terms. Draft for review, not yet effective.',
  reviewDate: '16 November 2026',
  sections: [
    {
      id: 'section-1',
      title: '1. Operator, agreement and authority',
      blocks: [
        {
          type: 'paragraph',
          text: "ATOMSTOBITS LABS INC., a Delaware corporation in the United States, provides OpenGen's hosted website, playground, generation API and MCP service at opengen.dev. In these Terms, “OpenGen,” “we” and “us” mean that company. “You” means the person accepting these Terms and any organization that person is authorized to represent.",
        },
        {
          type: 'paragraph',
          text: "These Terms form an agreement when you affirmatively accept them through an account, funding or other clearly presented acceptance process. You must be at least 18 (or the age of legal majority in your jurisdiction if higher), have the capacity required by applicable law, and have authority to accept for any organization you represent. Do not accept for an organization without that authority. A workspace member's technical permission does not necessarily give that member authority to change the organization's contract.",
        },
        {
          type: 'paragraph',
          text: "An OAuth scope or agent permission authorizes only the access it describes. It does not by itself accept unidentified terms, authorize a credit purchase or recurring card charge, or expand the delegate's contractual authority. Browsing the catalog does not purchase a service or grant an agent access.",
        },
        {
          type: 'paragraph',
          text: 'For legal, copyright, privacy and rights requests, contact legal@opengen.dev. For account, generation, billing and refund support, contact support@opengen.dev.',
        },
      ],
    },
    {
      id: 'section-2',
      title: '2. Service scope and document order',
      blocks: [
        {
          type: 'paragraph',
          text: 'OpenGen provides a common interface to image and video models served by different companies and regional deployments. A common parameter name does not make models equivalent. Capabilities, restrictions, prices and data handling depend on the exact model, operation and route.',
        },
        {
          type: 'paragraph',
          text: 'These Terms (including the prepaid credit, funding and refund rules in sections 8 through 10) govern the hosted service across the website, API, MCP and CLI. The Privacy Notice explains our handling of personal information and available controls. Route-specific model licenses, provider terms and required acceptable-use policies govern use of the corresponding model or provider. Their identification does not mean OpenGen has obtained every permission on your behalf.',
        },
        {
          type: 'paragraph',
          text: "Mandatory law takes priority. A separately signed agreement or completed Data Processing Addendum controls its covered subject. Sections 8 through 10 of these Terms control OpenGen prepaid credit funding, processing fees, balance reservations and refund arithmetic; general contract wording elsewhere in these Terms does not remove those express refund rights. An accepted quote and job approval control that job's pricing terms and basis, whether a price is fixed or estimated, payer, spending cap and request constraints. Applicable provider and model terms control the corresponding model use. General documentation or a later update does not silently replace an accepted request commitment. No document gives OpenGen rights it lacks upstream, reduces mandatory rights, forfeits money actually owed or restricts the published software license.",
        },
        {
          type: 'paragraph',
          text: 'Public documentation describes the current service. It creates a contractual performance commitment only when expressly identified and accepted as such. A privacy notice update alone does not grant a broader intellectual-property or training license.',
        },
      ],
    },
    {
      id: 'section-3',
      title: '3. Hosted access, platform rights and open source',
      blocks: [
        {
          type: 'paragraph',
          text: 'Subject to these Terms and the permissions issued to your workspace, we permit you to access the hosted service and use its documented interfaces for your own work or applications serving your end users. That permission is limited to the service access actually enabled for you. It does not permit credential sharing outside authorized grants, access-control evasion or unauthorized access to another workspace.',
        },
        {
          type: 'paragraph',
          text: 'We and the relevant rights holders retain rights in the hosted interface, documentation, branding and service technology, except for rights expressly granted under a software license. Do not reverse-engineer, decompile or attempt to extract non-open-source hosted operational infrastructure, private configurations or provider credentials, except to the extent applicable law prohibits that restriction. You may identify an accurate integration with OpenGen, but may not imply our endorsement, use our branding deceptively or claim ownership of our marks. This does not transfer your rights in inputs or outputs to us.',
        },
        {
          type: 'paragraph',
          text: 'Published source code and its dependencies have their own licenses. For software released under Apache License 2.0, that license governs copying, inspection, modification, redistribution and independent self-hosting. Nothing in these hosted Terms — including infrastructure or scraping restrictions — limits your Apache-2.0 rights in OpenGen source code, prohibits lawful forks or competing independent deployments, or makes us the operator of another installation. Conversely, the software license does not supply access to our hosted servers, customer data, provider accounts or trademarks. Calls from a self-hosted installation to our hosted service remain subject to these hosted Terms and issued permissions.',
        },
        {
          type: 'paragraph',
          text: 'If you voluntarily send suggestions specifically as nonconfidential feedback about OpenGen, you give us continuing, nonexclusive, worldwide, royalty-free permission to use, adapt and incorporate those suggestions to develop and improve products and services, without a payment or attribution obligation. You keep your rights in the feedback. This permission does not cover ordinary generation inputs or outputs, private workspace records, support attachments or vulnerability reports merely because we receive them. Their existing privacy, confidentiality and limited-processing protections remain. Source-code contributions follow their applicable contribution and software licenses.',
        },
      ],
    },
    {
      id: 'section-4',
      title: '4. Accounts, workspaces, keys and agents',
      blocks: [
        {
          type: 'paragraph',
          text: "Provide accurate account information and keep it current. Keep tokens, sessions and connected provider credentials secure; use permissions and spending limits appropriate to the task. Do not use another person's account or credentials without permission. Report suspected compromise promptly to support@opengen.dev. We may restrict or revoke compromised access to protect the service and affected users.",
        },
        {
          type: 'paragraph',
          text: 'Workspace administrators control membership, delegated access and spending permissions. Authorized members may see shared generation records and activity allowed by their roles. Administrators should explain that access to members. Removing a member or token affects future access; it does not undo provider work already accepted, erase an incurred charge or recall a downloaded result.',
        },
        {
          type: 'paragraph',
          text: "A workspace can authorize a person, application, CLI or AI agent to act within stated scopes and limits. Read access alone does not authorize generation. Generate access can spend the selected workspace's available balance or use an explicitly selected provider account. An agent or automated script can make rapid or unwanted requests while acting within a valid grant, so configure key/workspace budgets and review permissions carefully.",
        },
        {
          type: 'paragraph',
          text: 'Delegation does not authorize a new credit purchase, saved-card mandate, automatic recharge enrollment or broader grant; only an authorized human payer may approve funding. However, you and your workspace are responsible for generation consumption and any owner-enabled automatic recharges (up to the workspace and key spending and monthly recharge caps you configured) triggered by your authorized delegates, runaway scripts or agent loops, or customer-held credentials compromised before you revoke the key, session or mandate in your workspace, except to the extent caused by an OpenGen security, access-control or billing defect. A report of compromise does not establish whether an earlier upstream task was accepted; that question still requires recovery and reconciliation.',
        },
      ],
    },
    {
      id: 'section-5',
      title: '5. Models, providers and catalog evidence',
      blocks: [
        {
          type: 'paragraph',
          text: 'Model pages distinguish the model author from serving providers, resellers and regional deployments and provide original-source links. An Official label identifies an author-operated or documented first-party offering; it does not claim that OpenGen is endorsed by the author or has a reseller agreement. Multiple deployments of one company can have different availability and handling.',
        },
        {
          type: 'paragraph',
          text: "A catalog entry, citation or published price does not establish executable access for your account. Availability depends on credentials, permissions, parameters, restrictions and the service's current execution scope. Unknown information remains unknown. A Verified label applies only to its stated test configuration and evidence; it is not a general success-rate, uptime or future-performance promise.",
        },
        {
          type: 'paragraph',
          text: 'Review the applicable model license, provider terms and required use policies before selecting a route. For your own provider key (BYOK), your provider account and direct billing terms also apply. Ensure your authorized members and end users receive and comply with the applicable restrictions. A catalog listing or payment grants no rights that the relevant rights holder has not granted.',
        },
        {
          type: 'paragraph',
          text: "Before paid work, inspect the exact model, operation, route, payer, inputs, price basis, restrictions and any permitted fallback. Only the models, regions, requirements and attempts expressly covered by the approval are authorized; a permitted fallback is not permission to expand them or fund additional work. Material changes can require a new choice or approval. OpenGen cannot waive a provider's restrictions or guarantee the continuing availability of a particular model.",
        },
      ],
    },
    {
      id: 'section-6',
      title: '6. Your content, outputs and limited processing permission',
      blocks: [
        {
          type: 'paragraph',
          text: 'You keep the rights you hold in prompts, references and other submitted material. Obtain the permissions required for processing and intended use, including copyright, trademark, privacy, publicity, likeness and voice permissions. Public availability alone does not establish those permissions. Do not submit material you are not entitled to delegate for the requested processing.',
        },
        {
          type: 'paragraph',
          text: 'You give OpenGen a nonexclusive permission to receive, validate, copy, process, format, store and transmit that material only as needed to provide the authorized service: send necessary data to the selected provider, retain private workflow records and media, deliver results, recover accepted work, address support or security incidents and meet legal obligations. Necessary service processors may perform those functions for us. This is not a general-purpose training, public-gallery, marketing or content-sale license.',
        },
        {
          type: 'paragraph',
          text: 'The permission lasts only as needed for those purposes and legitimately retained copies described in the Privacy Notice. Deleting an input can prevent new use while accepted work still needs pinned bytes or necessary records. Retention for recovery, backups or legal obligations does not authorize unrelated reuse. Any additional upstream data-use term must be identified for the route; this paragraph does not quietly authorize it.',
        },
        {
          type: 'paragraph',
          text: 'We do not claim ownership of outputs because we delivered them. Your rights depend on applicable law, input rights and model/provider terms. We do not promise copyright protection, exclusivity, noninfringement or suitability for every commercial use. Others may obtain similar results. Closing a workspace does not itself transfer or revoke the lawful rights you already hold in received outputs; continuing model-license conditions still apply.',
        },
        {
          type: 'paragraph',
          text: "Review results before publication or reliance. Provenance or technical verification describes the evidence checked; it does not clear every intellectual-property right, establish a depicted person's consent or prove content is safe, accurate or lawful.",
        },
      ],
    },
    {
      id: 'section-7',
      title: '7. Private processing, confidentiality and external clients',
      blocks: [
        {
          type: 'paragraph',
          text: 'Generations are private to the owning workspace and its authorized access. Using OpenGen does not place your content in a public gallery or grant marketing permission. Authorized members, necessary processors and selected providers have access appropriate to the workflow. A short-lived bearer media link can also be used by someone who obtains it while valid. Token revocation does not necessarily recall an issued link or downloaded copy.',
        },
        {
          type: 'paragraph',
          text: 'A selected provider may process data in another location or under different storage and data-use rules. An endpoint region alone is not a guarantee about every inference, storage, support, account or payment-processing location. Review route disclosures and the Privacy Notice before submitting information requiring particular protections. These Terms promise no universal zero retention, fixed storage period or provider no-training arrangement.',
        },
        {
          type: 'paragraph',
          text: 'The Privacy Notice describes the purposes and controls for assets, accounts, jobs, financial records, security information and backups. Link expiry, deleting an asset and deleting all related records are different events. Keep your own copies of material you need; storage is not promised indefinitely. Requests and available deletion controls are explained in the Privacy Notice.',
        },
        {
          type: 'paragraph',
          text: 'An assistant, agent host or other external client has its own terms and information handling. It receives what you send through it and authorized results returned to it. Your grant does not make that client an OpenGen-operated service, and revocation does not delete its existing copies. The same applies to a webhook or destination you authorize. Select clients and destinations appropriate for the material involved.',
        },
        {
          type: 'paragraph',
          text: "Each party will protect the other's nonpublic information that is identified as confidential or reasonably understood to be confidential from its nature or context. This includes private generation material, credentials and nonpublic business, security and contract information; a confidentiality label is not required for private workspace content. Public source code, public catalog facts and other publicly released material do not become confidential under this section.",
        },
        {
          type: 'paragraph',
          text: 'Use confidential information only for the authorized service relationship and protect it with reasonable care. Limit disclosure to authorized people and necessary service providers or advisers who need it for that purpose and are subject to appropriate confidentiality or legal duties. The receiving party remains responsible for its obligations when using them. Information lawfully public without a breach, already lawfully known without restriction, independently developed without using the confidential information, or properly received from another source is excluded from this contractual definition; applicable personal-data duties still apply.',
        },
        {
          type: 'paragraph',
          text: 'If disclosure is legally required, disclose only what is required and, where lawful, give reasonable notice and assistance to seek protection. Return or delete information when the relationship ends or on a valid request, subject to accepted-work recovery, required records, lawful retention and backup limits described in the Privacy Notice. Retained information remains protected while confidential; trade secrets retain applicable protection. This section does not enlarge our content-processing permission, prevent lawful protected disclosures, or change source-license, deletion or mandatory legal rights.',
        },
      ],
    },
    {
      id: 'credits-and-refunds',
      title: '8. Prepaid credit, saved cards, automatic recharge and processing fees',
      blocks: [
        {
          type: 'paragraph',
          text: "Managed usage draws on the selected workspace's USD prepaid service balance. One dollar of purchased balance provides one dollar toward authorized OpenGen charges; it is not a bank deposit, e-money account or investment, earns no interest, and cannot be transferred between workspaces or resold. Direct provider billing through your own connected key (BYOK) is separate and bypasses OpenGen generation charges. The same accepted pricing, reservation, cancellation and settlement rules apply across the website, REST API, MCP and CLI. Model generation routes carry a 0% OpenGen markup over the route's stated rate unless a separate generation fee is expressly disclosed and accepted before authorization.",
        },
        {
          type: 'paragraph',
          text: 'Workspace billing requires explicit enrollment by an authenticated human workspace administrator (one active human funding owner per workspace at a time). An enrolled human funding owner may purchase $5.00 to $9,999.00 in USD prepaid service credit per human-approved one-time Stripe Hosted Checkout top-up or opt-in saved-card automatic recharge. To ensure 100% of the requested USD credit principal is added to the workspace balance, an upfront payment processing fee is added on top of the credit amount: a 2.9% + $0.30 gross-up on Hosted Checkout and US-issued saved cards (computed in integer cents as ceil((credit + $0.30) / 0.971) - credit), and a 4.4% + $0.30 gross-up on non-US saved cards used for automatic recharge (computed in integer cents as ceil((credit + $0.30) / 0.956) - credit). Exact USD credit added, processing fee and rate, any applicable tax, and total payment are shown before you confirm.',
        },
        {
          type: 'paragraph',
          text: 'The active human funding owner may save a card through Stripe Setup and separately opt into bounded automatic recharge by configuring a balance threshold, recharge credit amount ($5.00 to $9,999.00), monthly recharge cap, cooldown and attempt/failure limits. Saving a payment method without enabling automatic recharge, granting an agent or key Generate access, or exhausting a workspace balance alone never authorizes an automatic card charge or subscription. When a card issuer requires customer authentication (such as 3D Secure) for an off-session recharge attempt, new automatic charges pause until the funding owner completes authentication recovery or updates the card. Automatic recharge and saved-card mandates may be disabled or revoked at any time to stop future charges, while any payment instruction already submitted to Stripe finishes reconciliation. Available payment methods are those shown in Stripe Checkout or Setup (no cryptocurrency or unlisted methods). Usable credit equal to the requested credit principal is added once after verified paid confirmation; browser redirects or pending intents are not proof of funding.',
        },
        {
          type: 'paragraph',
          text: 'A quote is an estimate unless expressly fixed; price and availability are rechecked at admission, and an admitted job retains its accepted rate snapshot rather than being silently repriced. A reservation sets aside balance temporarily and is not a final debit or cash refund. For managed calls, the final OpenGen customer charge cannot exceed the accepted reservation or a stricter accepted request cap; OpenGen absorbs supplier overruns above that ceiling rather than silently debiting extra balance or charging your card. Unknown upstream acceptance or cost stays reserved until reconciled; preserve the job ID and resume the original task rather than blindly submitting a replacement paid generation.',
        },
        {
          type: 'paragraph',
          text: 'OpenGen makes no promise of free, referral or promotional credit. If we offer an identified noncash grant, its stated terms govern; it is non-transferable, cannot offset taxes, and is not cash-refundable unless law requires otherwise. For manual refund accounting, staff reconstruct funding and usage chronologically from payment, job and ledger records: noncash credit available at admission is consumed first, followed by paid credit oldest-purchase-first, while released reservations restore their original funding character and purchase date.',
        },
      ],
    },
    {
      id: 'section-9',
      title: '9. Refunds, sub-cent rounding, aged holds and credit expiry',
      blocks: [
        {
          type: 'paragraph',
          text: 'Ordinary 24-hour voluntary refund window: You may request return of the unused paid remainder within 24 hours after successful payment confirmation for a purchase or recharge by emailing support@opengen.dev with your workspace and order or payment reference (never send full card numbers, passwords or API secrets). Partial generation usage does not disqualify the remaining unused balance, and a timely request stays timely during staff verification and accepted-cost reconciliation; stop spending balance you want returned. The separately disclosed upfront payment processing fee covers payment-network processing and is nonrefundable on ordinary voluntary unused-credit refunds. Voluntary refunds therefore return up to 100% of the unused paid credit principal (creditCents), excluding consumed amounts, prior returns, noncash grants and genuinely unresolved accepted-work exposure, with no additional OpenGen refund-processing fee.',
        },
        {
          type: 'paragraph',
          text: 'Fractions of a cent, destination and timing: Usage settles in integer millionths of a US dollar ($0.000001), whereas cash refunds settle in cents. Any positive refundable paid remainder is rounded up to the next cent, capped at the remaining refundable credit principal (creditCents) of the original payment, with OpenGen bearing the sub-cent rounding difference (for example, $4.993456 eligible paid credit produces a $5.00 refund when at least $5.00 principal remains). Reservation release restores workspace spending capacity and is distinct from a cash refund; refunded balance is removed once so the same amount cannot be spent or returned twice. Eligible refunds are returned to the original payment method after verifying payer and workspace authority (or a verified lawful alternative if the original route cannot process the return). Operational staff targets are acknowledgement within one business day, decision or information request within five business days, and processor initiation within two business days after reconciliation; card issuers commonly post returns within five to ten business days.',
        },
        {
          type: 'paragraph',
          text: "Failed, cancelled and aged unresolved jobs: Work rejected before upstream acceptance with no incurred charge releases its reservation without usage billing; accepted upstream work can remain billable after failure, cancellation request or delivery retry according to route terms and billing evidence. Disliking a creative output alone is not a technical service defect, while OpenGen billing errors or failures to meet an express technical commitment retain appropriate credit or refund remedies regardless of an upstream supplier's own refund policy. An acceptance or cost question unresolved for 24 hours enters manual billing review (first explanation target within two business days and weekly updates). By day 30, the billing owner makes a documented decision either settling on reliable evidence within the customer limit or providing an OpenGen-funded adjustment or return while preserving genuinely unknown supplier-cost records.",
        },
        {
          type: 'paragraph',
          text: "Closure refunds and possible future expiry: Voluntary workspace closure, OpenGen termination without cause, closure after declining a material Terms change, or permanent discontinuation of the paid service entitles you to reconciliation and return of your unused paid credit principal even after the 24-hour voluntary window (targeting processor initiation within 30 calendar days, subject to earlier legal deadlines). Unauthorized or duplicate charges, missing funding after confirmed payment, billing errors and mandatory statutory rights likewise remain unaffected by the 24-hour window. There is no automatic paid-credit expiry at launch. OpenGen reserves a discretionary right, where lawful, to expire unused paid credit no earlier than 365 days after purchase only after giving at least 30 calendar days' direct advance notice identifying the amount and date and allowing you either to use the credit or request cash return of the unused paid remainder before expiry.",
        },
      ],
    },
    {
      id: 'section-10',
      title: '10. Taxes, chargebacks and EEA/UK statutory withdrawal',
      blocks: [
        {
          type: 'paragraph',
          text: "Funding and refund principal are denominated in USD; your bank's currency conversion rate or card foreign-exchange fee is separate and outside OpenGen's control. Stated prices, generation rates and credit amounts exclude applicable sales, use, value-added (VAT), goods-and-services (GST), gross-receipts or similar indirect transaction taxes, duties or government charges. You are responsible for applicable transaction taxes disclosed before payment confirmation (excluding taxes based on OpenGen's net income), and all payments must be made free of customer tax withholding or deduction. Promotional or noncash credits cannot be applied toward taxes. Any legally required tax adjustment on a refund follows the actual transaction and applicable tax law.",
        },
        {
          type: 'paragraph',
          text: 'Contact support@opengen.dev promptly about any suspected unauthorized, duplicate or erroneous charge; seeking support never waives a lawful card-network dispute, statutory withdrawal right or consumer remedy. However, initiating an improper, fraudulent or bad-faith chargeback or payment reversal on a valid purchase or already-consumed balance places workspace spending and funding into immediate review hold, revokes active saved-card mandates and automatic recharge, and entitles OpenGen to offset established reversed amounts against remaining workspace credit while accepted jobs complete recovery and settlement.',
        },
        {
          type: 'paragraph',
          text: 'Where EEA or UK consumer withdrawal law applies to your online purchase, you ordinarily have 14 days from concluding the contract to withdraw without giving a reason, subject to applicable statutory rules and exceptions. Send a clear withdrawal statement to support@opengen.dev before the 14-day period expires, identifying the purchase and contact details; no special form is required, and the 24-hour voluntary refund window never shortens statutory rights. For a valid statutory withdrawal, we reimburse amounts required by law without undue delay and ordinarily within 14 days of your notice using the original payment method (unless you expressly agree otherwise), with no reimbursement fee. Any proportional deduction for service begun at your express request or loss of withdrawal rights for digital content supplied during the withdrawal period applies only where the legally required pre-contract information, express request, consent, acknowledgement and confirmation conditions were actually satisfied; sign-in, purchasing credit or granting general agent access does not by itself waive statutory withdrawal rights.',
        },
      ],
    },
    {
      id: 'section-11',
      title: '11. Acceptable use, AI safety, provenance and end-user applications',
      blocks: [
        {
          type: 'paragraph',
          text: 'Zero-tolerance child safety: Never use OpenGen to generate, upload, solicit, process or distribute child sexual exploitation and abuse material (CSAM/CSAE), child grooming or sextortion, or any sexualized depiction of a minor. OpenGen immediately suspends and terminates offending accounts, preserves required evidence, and reports apparent CSAM/CSAE to the National Center for Missing & Exploited Children (NCMEC) and competent law-enforcement authorities.',
        },
        {
          type: 'paragraph',
          text: "Prohibited harmful, deceptive and biometric uses: Do not use OpenGen to break the law or violate another person's rights. Prohibited conduct includes nonconsensual intimate imagery (NCII); unauthorized voice cloning or photorealistic likeness/deepfake generation of a real person without required consent or lawful authority; deceptive impersonation in elections, government or civic processes, financial fraud or defamation; real-time biometric identification, facial-recognition database building or unlawful biometric surveillance; self-harm encouragement or instruction; chemical, biological, radiological or nuclear (CBRN) weapons or dangerous materials; malware, cyberattacks or abusive unsolicited messaging; and infringement of copyright, trademark, publicity or privacy rights.",
        },
        {
          type: 'paragraph',
          text: 'Content provenance, C2PA credentials and safety watermarks: Do not strip, remove, alter, obscure or spoof C2PA Content Credentials, cryptographic provenance manifests, invisible or visible AI safety watermarks (such as SynthID or provider provenance signals), or proprietary notices embedded in or attached to generated media where present or required by applicable law or upstream model terms. Do not misrepresent synthetic media as authentic human-captured footage or recordings where doing so would deceive people or violate law or provider policies.',
        },
        {
          type: 'paragraph',
          text: "Platform integrity, scraping and upstream model restrictions: Do not access another workspace's data, use stolen or unauthorized credentials, evade spending, rate or eligibility limits, create multiple accounts to circumvent restrictions or abuse promotional credits, or run unauthorized automated scraping or bulk harvesting against non-API hosted web pages. Do not attempt to extract upstream model weights or architectures, or use outputs from a hosted model route to train, distill or fine-tune a competing machine-learning model where prohibited by that model's license or serving provider's terms. Do not put secrets in prompts, public feedback or support messages. Ordinary use of documented REST APIs, MCP, CLI, /llms.txt and public .md discovery documents within issued limits — as well as exercising Apache-2.0 rights in OpenGen's open-source code — is expressly permitted.",
        },
        {
          type: 'paragraph',
          text: "Vulnerability reporting: Do not attack or deliberately overload the hosted service, probe its security without authorization or escape an execution boundary. If you discover a suspected security vulnerability, stop before accessing another user's data or causing disruption and report it privately to support@opengen.dev (or an available repository private-security channel) with minimal reproduction details and no live secrets or unnecessary private media. Responsible reporting creates no cash bounty, guaranteed remediation SLA or indefinite restriction on lawful protected disclosure.",
        },
        {
          type: 'paragraph',
          text: 'Applications serving end users: If you build an application or workflow for end users using OpenGen, you must enforce an 18+ minimum age requirement (including any age-gating or age verification required by applicable law), provide accurate notice of applicable route and provenance restrictions, obtain necessary rights and consents for end-user inputs, and maintain reasonable abuse-prevention controls. Building an application grants no endorsement by OpenGen and overrides no upstream model restriction. OpenGen may investigate suspected violations and restrict activity under section 15.',
        },
      ],
    },
    {
      id: 'section-12',
      title: '12. Export controls, sanctions and territorial restrictions',
      blocks: [
        {
          type: 'paragraph',
          text: 'You must comply with all applicable export-control, trade and economic sanctions laws, including the U.S. Export Administration Regulations (EAR), sanctions administered by the U.S. Department of the Treasury Office of Foreign Assets Control (OFAC), U.S. Department of State restrictions, European Union sanctions and UK HM Treasury sanctions. You represent that you (and any organization or end user for whom you act) are not located in, organized under the laws of, or ordinarily resident in any country or territory subject to comprehensive U.S. embargoes or sanctions (including Cuba, Iran, North Korea, Syria, and comprehensively sanctioned regions of Ukraine), are not listed on the OFAC Specially Designated Nationals (SDN) List, the U.S. Entity List or Denied Persons List, or equivalent EU/UK restricted-party lists, and will not use the service for any prohibited military, proliferation or restricted end use.',
        },
        {
          type: 'paragraph',
          text: "Do not misrepresent eligibility or use a VPN, proxy, alternate account or intermediary to evade legal, model-author or serving-provider geographic or entity restrictions. Upstream provider availability can be narrower than locations where OpenGen's website loads, and a listed API endpoint region does not make a restricted model lawful for every person there. We may request reasonable eligibility confirmation or pause affected activity when law or an upstream provider requires it.",
        },
      ],
    },
    {
      id: 'section-13',
      title: '13. API changes, previews and compatibility',
      blocks: [
        {
          type: 'paragraph',
          text: 'Models, schemas, endpoints and features can change or become unavailable. Documentation and enabled capabilities describe what is currently supported. Maintain integrations against the documented interface and observe applicable usage limits. Do not assume a model, parameter or unversioned implementation detail will remain available forever.',
        },
        {
          type: 'paragraph',
          text: 'For a planned change to a public interface identified as stable that would materially break ordinary integrations, we will use reasonable efforts to give advance notice and practical migration information. Urgent security, legal or upstream changes may require shorter notice. This is not a guarantee of perpetual backward compatibility, a fixed deprecation period or a service-level agreement.',
        },
        {
          type: 'paragraph',
          text: 'Features clearly labeled beta, preview or experimental can have incomplete capabilities and may change or end with shorter notice. Evaluate them before relying on them for important work. A preview label does not authorize undisclosed charges or remove mandatory remedies.',
        },
        {
          type: 'paragraph',
          text: 'Changes do not authorize a silent paid model substitution or a replacement generation. For already-accepted work, we will use reasonable efforts to preserve original-job status/recovery or provide an appropriate support path where possible and lawful. This does not guarantee uninterrupted access, recoverability of expired upstream assets or indefinite media retention.',
        },
      ],
    },
    {
      id: 'section-14',
      title: '14. Copyright (DMCA), likeness and safety reports',
      blocks: [
        {
          type: 'paragraph',
          text: 'Send copyright, trademark, privacy, likeness/voice or unlawful-content complaints to legal@opengen.dev (or by mail to Copyright Agent, ATOMSTOBITS LABS INC., 201 Folsom St, San Francisco, CA 94105, United States). Private workspace material can be referenced by job or asset identifier; never publish a bearer media link, API secret or unnecessary sensitive media to submit a report.',
        },
        {
          type: 'paragraph',
          text: 'DMCA Takedown Notices (17 U.S.C. § 512(c)(3)): If you are a copyright owner or authorized agent reporting alleged copyright infringement on OpenGen-hosted storage, your written notice to our Copyright Agent must include: (1) a physical or electronic signature of a person authorized to act on behalf of the owner of an exclusive copyright right allegedly infringed; (2) identification of the copyrighted work claimed to have been infringed (or a representative list if multiple works are covered); (3) identification of the material claimed to be infringing or to be the subject of infringing activity and information reasonably sufficient to permit OpenGen to locate it (such as the specific OpenGen job/asset identifier or URL); (4) your name, mailing address, telephone number and email address; (5) a statement that you have a good-faith belief that use of the material in the manner complained of is not authorized by the copyright owner, its agent or the law; and (6) a statement that the information in the notification is accurate, and under penalty of perjury, that you are authorized to act on behalf of the owner of an exclusive right that is allegedly infringed.',
        },
        {
          type: 'paragraph',
          text: 'DMCA Counter-Notices (17 U.S.C. § 512(g)(3)): If your material was removed or disabled due to a copyright notice and you believe in good faith it was removed by mistake or misidentification, you may send a written counter-notice to legal@opengen.dev containing: (1) your physical or electronic signature; (2) identification of the material removed or disabled and the location where it appeared before removal; (3) a statement under penalty of perjury that you have a good-faith belief the material was removed or disabled as a result of mistake or misidentification; and (4) your name, physical address, telephone number and email address, together with a statement that you consent to the jurisdiction of the Federal District Court for the judicial district in which your address is located (or, if your address is outside the United States, the U.S. District Court for the District of Delaware or the Northern District of California) and that you will accept service of process from the person who provided the original notification or their agent.',
        },
        {
          type: 'paragraph',
          text: 'Action on reports and repeat infringers: We may request verification details, restrict access, preserve required evidence, notify the affected account holder where lawful, and remove or disable material where justified or required by law (urgent safety issues may require immediate action). We do not promise restoration while an independent legal or safety prohibition applies. OpenGen terminates accounts of repeat copyright infringers in appropriate circumstances under section 15. Knowingly materially misrepresenting that material is infringing, or was removed by mistake or misidentification, violates these Terms and may result in statutory liability under 17 U.S.C. § 512(f).',
        },
      ],
    },
    {
      id: 'section-15',
      title: '15. Suspension, termination and effects',
      blocks: [
        {
          type: 'paragraph',
          text: 'We may pause or restrict new activity to address suspected compromise, material abuse, payment reversals, legal requirements, provider restrictions or serious operational risk. Immediate action can be necessary to protect people, data or funds. Where reasonably possible and legally permitted, we will explain the reason and how to contact us about an error.',
        },
        {
          type: 'paragraph',
          text: 'For a material breach that can reasonably be cured without continuing the risk, we will ordinarily give written notice and 30 days to cure before permanent termination. An urgent, unlawful, incurable or serious repeated breach can require immediate restriction or termination. A cure period does not require us to continue unsafe paid processing or override a legal deadline.',
        },
        {
          type: 'paragraph',
          text: "If we end the hosted relationship without cause, we will ordinarily give 30 days' notice where practicable. Where lawful and technically available, we will provide a reasonable opportunity to retrieve your authorized existing results or request assistance before access ends. We do not guarantee recovery of material already expired or legitimately deleted, or export of material you are not entitled to possess.",
        },
        {
          type: 'paragraph',
          text: 'You can stop using the service and request closure through support@opengen.dev or an available published account process. Termination or suspension does not erase accepted work, unknown costs, financial evidence, accrued obligations or valid claims. Accepted tasks may still require status, cancellation or cost reconciliation through a lawful authorized recovery path. Neither continued credentials nor uninterrupted access is guaranteed during a restriction.',
        },
        {
          type: 'paragraph',
          text: 'Unused purchased credit and refunds remain governed by sections 8 through 10 and mandatory legal rights; closure or breach does not declare all paid funds automatically confiscated, though we may lawfully offset established amounts owed during fraud, breach or chargeback review. If we end the relationship without cause or withdraw the paid service so that you cannot reasonably use your remaining purchased balance, we will return the unused paid remainder after accepted-cost reconciliation even if the 24-hour voluntary refund window has closed. Media and records are handled under the Privacy Notice, with necessary legal and recovery limits. Notice/cure periods do not delay a refund or other remedy that must be provided sooner.',
        },
      ],
    },
    {
      id: 'section-16',
      title: '16. Service warranties, force majeure and output review',
      blocks: [
        {
          type: 'paragraph',
          text: 'Except for an express commitment we have accepted in writing and protections that applicable law requires, the service and outputs are provided as available. To the extent legally permitted, we disclaim implied warranties of merchantability, fitness for a particular purpose and noninfringement. Nothing here cancels an accepted technical commitment or a mandatory standard of care.',
        },
        {
          type: 'paragraph',
          text: 'We do not promise uninterrupted or error-free operation, exact completion times, a particular artistic result, universal provider success, unique outputs or continuing access to a particular model. No service-level commitment exists unless separately agreed. Provider limitations do not excuse our own independent legal, security or billing obligations.',
        },
        {
          type: 'paragraph',
          text: "Generated media can contain mistakes, misleading depictions, artifacts or third-party material. Review accuracy, rights and suitability before distribution or reliance, including uses affecting a person's rights, safety or livelihood. An output or provenance signal is not professional advice or independent verification of an event, identity, consent or legal clearance. Apply safeguards suitable for the use rather than treating generation as proof.",
        },
        {
          type: 'paragraph',
          text: 'These qualifications do not exclude mandatory consumer guarantees or remedies for an unauthorized payment, defective service or other matter that law protects.',
        },
        {
          type: 'paragraph',
          text: 'Where law permits, neither party is responsible for a delay to the extent directly caused by an event outside its reasonable control that it could not reasonably avoid or overcome, such as a widespread network disruption or natural disaster. The affected party must take reasonable steps to limit the impact, notify the other where practical and resume performance. This does not excuse deficient security or reasonable continuity measures, erase charges or refunds actually owed, remove accepted spending limits, or authorize replacement paid work. If paid service cannot continue, the closure and refund rules still apply; an outside event does not forfeit an unused balance.',
        },
      ],
    },
    {
      id: 'section-17',
      title: '17. Liability limits and preserved remedies',
      blocks: [
        {
          type: 'paragraph',
          text: 'To the extent applicable law permits, OpenGen is not liable for indirect, special, consequential or punitive losses, including lost business opportunities, profits or goodwill arising from use or inability to use the service. This allocation does not exclude a loss or remedy that law does not allow us to exclude, even if a similar loss has a commercial label.',
        },
        {
          type: 'paragraph',
          text: "Subject to the exceptions below, OpenGen's total liability arising out of the hosted agreement is limited to the greater of (a) the OpenGen service charges actually paid and settled from purchased balances by you, or by the organization on whose behalf you accepted this agreement, in the 12 months before the first event giving rise to the claim, or (b) US $100. Managed provider charges settled as OpenGen service charges count; unused top-ups, unresolved reservations, promotional credit and amounts paid directly to another provider do not. Related claims do not multiply this limit. This section also applies to our personnel acting in their work for us.",
        },
        {
          type: 'paragraph',
          text: 'Neither the exclusion nor the cap limits liability for our fraud, intentional misconduct or gross negligence; death or personal injury caused by our negligence; or any liability or remedy that applicable law does not permit us to limit. Mandatory consumer and unauthorized-payment rights remain unaffected.',
        },
        {
          type: 'paragraph',
          text: 'These limits do not reduce money refunds, restoration of unused purchased credit, release/correction of improper holds or debits, or other financial amounts actually owed under sections 8 through 10 or applicable law. They do not turn unresolved cost into a final debit or permit us to keep money we must return. Sections 8 through 10 still determine the financial correction; damages for a separate claim are a different question.',
        },
      ],
    },
    {
      id: 'section-18',
      title: '18. Bounded third-party claim responsibility',
      blocks: [
        {
          type: 'paragraph',
          text: 'If you use OpenGen in business, you will reimburse us for reasonable amounts finally awarded to a third party, or agreed in a settlement approved as below, to the extent a claim is caused by content you lacked the necessary rights to submit or your unlawful use or material breach of sections 6, 11 or 12. This includes reasonable defense costs for that claim. It does not cover a claim merely because your account or output appears in it.',
        },
        {
          type: 'paragraph',
          text: "This obligation excludes the extent caused by our breach, negligence or misconduct; processing beyond the permission you gave; a provider's independent acts or failures; or modifications/use by us or others that you did not authorize and that caused the claim. It does not shift our security or billing errors, mandatory duties or remedies onto you, and does not make you responsible for an unrelated third party's conduct. Consumer protections that cannot lawfully be waived remain intact.",
        },
        {
          type: 'paragraph',
          text: "We will notify you promptly, provide reasonable cooperation and allow you to control the defense using competent counsel. A notice delay reduces your obligation only to the extent it materially prejudices the defense. We may participate with our own counsel at our expense. Neither party may settle in a way that admits fault, imposes nonmonetary duties or fails to release the other without that party's written consent, which must not be unreasonably withheld. If you do not take up a required defense after reasonable notice, we may defend reasonably and seek only costs covered by this section.",
        },
      ],
    },
    {
      id: 'section-19',
      title: '19. Disputes, governing law and courts',
      blocks: [
        {
          type: 'paragraph',
          text: 'Contact support@opengen.dev for service/billing concerns and legal@opengen.dev for a legal dispute, identifying the relevant workspace, order or job and the remedy requested. We will try in good faith to resolve the matter. This informal step does not prevent urgent relief, a required regulatory complaint or action needed to preserve a legal deadline.',
        },
        {
          type: 'paragraph',
          text: "Delaware law governs the hosted agreement, excluding its choice-of-law rules, subject to mandatory protections that apply to you. To the extent lawful, the applicable state or federal courts located in Delaware are the exclusive forum for disputes under this agreement, and each party consents to their personal jurisdiction. A consumer retains any nonwaivable right to the protections and courts available under the law of the consumer's residence.",
        },
        {
          type: 'paragraph',
          text: "These Terms do not require arbitration or waive class proceedings or a jury trial. A support request is not a waiver of a lawful chargeback, consumer claim or other remedy. This choice concerns OpenGen's hosted relationship; an independent upstream agreement can address its own parties separately.",
        },
        {
          type: 'linkedParagraph',
          parts: [
            'California consumers may also contact the California Department of Consumer Affairs, Consumer Information Center, at 1625 North Market Blvd., Suite N 112, Sacramento, CA 95834, or (800) 952-5210. Its ',
            {
              label: 'consumer-assistance page',
              href: 'https://www.dca.ca.gov/about_us/contactus.html',
            },
            " explains available help and referrals. This is an independent government contact, not OpenGen's address or a promise that the agency resolves every type of claim.",
          ],
        },
      ],
    },
    {
      id: 'section-20',
      title: '20. Electronic communications (E-SIGN) and Terms changes',
      blocks: [
        {
          type: 'paragraph',
          text: 'By creating an account, approving funding or accepting these Terms electronically, you consent to receive agreements, disclosures, receipts, billing statements and legal or operational notices electronically (via your verified account email or in-product notices) and agree that electronic acceptance and electronic records satisfy legal writing and signature requirements to the fullest extent permitted by the U.S. Electronic Signatures in Global and National Commerce Act (E-SIGN) and similar applicable laws. Keep your account contact details current; sending to an outdated address does not excuse a notice duty that law independently imposes on us. Send formal legal notices to legal@opengen.dev (or our San Francisco mailing address) unless a specific legal process requires another method. Optional marketing communications are separate from required account, security and billing notices.',
        },
        {
          type: 'paragraph',
          text: "Adopted Terms state their effective date, and we make the current text available at opengen.dev/terms. For a material change reducing rights or increasing obligations, we will give at least 30 days' advance notice by an appropriate account or in-product channel. A law-driven or urgent security/abuse change may take effect sooner only to the extent necessary, with notice as soon as reasonably possible and legally permitted. Minor corrections or changes solely benefiting users may take effect when published.",
        },
        {
          type: 'paragraph',
          text: 'Changes apply prospectively. They do not retroactively authorize a new charge, broader content use, a different paid request or forfeiture of an existing refund right. Continued future use after clear notice and the effective date can indicate acceptance only where legally permitted; where fresh affirmative agreement is required, we will obtain it before the affected activity. If you decline a material change and close because you cannot continue under the prior terms, we will return your unused purchased remainder after accepted-cost reconciliation even if the voluntary refund-request window has closed. Accrued rights and recovery of existing work remain. Earlier terms continue to govern a previously accepted request or accrued dispute to the extent applicable.',
        },
      ],
    },
    {
      id: 'section-21',
      title: '21. General contract provisions and U.S. Government rights',
      blocks: [
        {
          type: 'paragraph',
          text: "These Terms and any other documents expressly incorporated within their stated scope form the entire agreement for the hosted service, subject to section 2's priority rules. They do not erase a separately signed agreement, an accepted request commitment, accrued rights or the published software licenses. An amendment outside the stated update process must be agreed in writing by authorized representatives.",
        },
        {
          type: 'paragraph',
          text: "Neither party may transfer the hosted agreement without the other's written consent, except that we may transfer it as part of a merger, reorganization or sale of the relevant business to a successor responsible for its obligations. We will provide appropriate notice and preserve applicable privacy, refund and consumer rights. Contract assignment does not enable sale of customer credentials, transfer of workspace balance through an unavailable feature or unrelated reuse of private content. Separate input/output and source-license rights remain governed by their applicable terms.",
        },
        {
          type: 'paragraph',
          text: 'If a provision is unenforceable, it is limited only as necessary and the remaining agreement continues where lawful. Not enforcing a provision once does not waive later enforcement. Section titles do not alter meaning. No unrelated third party receives rights under this agreement merely because it is mentioned; any expressly agreed third-party rights must be identified in the applicable agreement. For U.S. Government end users acquiring access to the hosted service, the hosted service and documentation are “commercial computer software” and “commercial computer software documentation” provided strictly with the commercial rights and restrictions in these Terms in accordance with FAR 12.212 and DFARS 227.7202, without restricting Apache-2.0 open-source rights in published source code.',
        },
        {
          type: 'paragraph',
          text: 'Rights and obligations that need to continue after termination do so to that extent, including payment/cost reconciliation, valid refunds, lawful content rights, necessary records, accrued claims, dispute handling and the applicable liability/claim provisions. Survival does not create an indefinite content-use permission or override deletion and legal-retention limits.',
        },
      ],
    },
    {
      id: 'section-22',
      title: '22. Contact',
      blocks: [
        {
          type: 'paragraph',
          text: "OpenGen's operator is ATOMSTOBITS LABS INC., a Delaware corporation in the United States. Contact legal@opengen.dev for legal notices, DMCA copyright notices, privacy/rights requests and content complaints. Contact support@opengen.dev for accounts, generation, billing, refunds and service support. Include relevant identifiers and a concise explanation; do not send passwords, API secrets, private tokens or complete payment details.",
        },
        {
          type: 'paragraph',
          text: 'Our business and legal-notice mailing address is ATOMSTOBITS LABS INC., 201 Folsom St, San Francisco, CA 94105, United States.',
        },
      ],
    },
  ],
} satisfies LegalPolicy;

export const privacyPolicy = {
  slug: 'privacy',
  navigationLabel: 'Privacy draft',
  title: 'OpenGen Privacy Notice',
  description: 'Proposed OpenGen Privacy Notice. Draft for review, not yet effective.',
  reviewDate: '16 November 2026',
  sections: [
    {
      id: 'section-1',
      title: '1. Who we are and how to contact us',
      blocks: [
        {
          type: 'paragraph',
          text: "ATOMSTOBITS LABS INC., a Delaware corporation in the United States, operates OpenGen's hosted website, playground, API and MCP service at opengen.dev. “OpenGen,” “we” and “our” refer to that company.",
        },
        {
          type: 'paragraph',
          text: 'Contact legal@opengen.dev for privacy questions, rights requests, appeals, complaints and legal notices. Contact support@opengen.dev for account, generation, billing, refund and other service support. You do not need an OpenGen account to raise a privacy concern.',
        },
        {
          type: 'paragraph',
          text: 'Our business and privacy-notice mailing address is ATOMSTOBITS LABS INC., 201 Folsom St, San Francisco, CA 94105, United States.',
        },
      ],
    },
    {
      id: 'section-2',
      title: '2. Scope and responsibility',
      blocks: [
        {
          type: 'paragraph',
          text: "This notice covers the hosted service. The open-source software license is separate. An independent self-hosted installation has its own operator and privacy practices; this notice does not cover that installation's independent handling.",
        },
        {
          type: 'paragraph',
          text: 'We determine how information is used for our own account administration, access controls, security, support, billing and legal obligations. Depending on applicable law (including the EEA/UK General Data Protection Regulation and U.S. state privacy statutes), we act as a data controller or business for that handling.',
        },
        {
          type: 'paragraph',
          text: "For personal information processed on an organization's instructions in its generation workflows, that organization may be the controller or business and OpenGen may act as its processor or service provider under the applicable agreement. The role follows the actual activity and agreement; not every record connected to a business workspace has the same role. An organization also controls workspace membership, permissions and its uses of results. Ask your administrator about those decisions; you can still contact us about our handling.",
        },
        {
          type: 'paragraph',
          text: 'Business customers that need a data-processing agreement or information about subprocessors, assistance, deletion/return or transfers should contact legal@opengen.dev before submitting information requiring those arrangements. This notice is not itself an executed DPA and does not establish coverage for every provider or route. We will identify the arrangements available for the proposed service rather than treat a request as acceptance of an unprovided contract.',
        },
      ],
    },
    {
      id: 'section-3',
      title: '3. Information, sources and California Notice at Collection',
      blocks: [
        {
          type: 'table',
          columns: ['Category', 'Examples and sources'],
          rows: [
            [
              'Account and access',
              'Google sign-in identifiers/claims; contact details you supply; workspace membership and roles from you or an administrator; session, API-key and OAuth client/grant records created by access features',
            ],
            [
              'Terms acceptance evidence',
              'For adopted, effective Terms after validated Continue and verified sign-in: identity-provider issuer and account subject, server-selected Terms snapshot identifier and content fingerprint, fixed notice/action/verification method, and database timestamp. This documents the identified Terms and action associated with the verified account; draft-policy sign-in creates no such receipt. The receipt adds no separate email, IP-address or device data, prompts, media or tokens.',
            ],
            [
              'Generation content',
              'Prompts, parameters, reference files/URLs, private labels and project information submitted by you or an authorized client; generated media and responses from the selected provider',
            ],
            [
              'Workflow and usage',
              'Job, attempt, status, delivery and lineage records; request identities, quotes, reservations, cost evidence and settlements created while running and reconciling work',
            ],
            [
              'Provider connections',
              'Connected credentials and connection metadata, including protected original-attempt credentials needed to recover an accepted task',
            ],
            [
              'Payments',
              'Workspace funding-owner/authority records, order and recharge-attempt identifiers, credit principal, processing fee and total charge amounts, currency, minimized Stripe customer/mandate/setup/payment identifiers, saved card two-letter ISO country code (used solely to determine domestic 2.9% + $0.30 vs international 4.4% + $0.30 processing fee rates — never full card numbers or CVC), off-session recharge attempt/authentication-recovery status, and reconciliation, refund and dispute status; accounting records created by the service',
            ],
            [
              'Browser and operations',
              'Functional cookies/recovery storage; request times, registered routes/status, IP address and request/device information handled by the service or hosting/edge infrastructure',
            ],
            [
              'Support and security',
              'Messages and identifiers you provide; reports from someone raising a concern; evidence needed to resolve it, protect the service or meet legal obligations',
            ],
          ],
        },
        {
          type: 'paragraph',
          text: "Sources include you, your authorized agents and collaborators, workspace administrators, sign-in and payment services, selected generation providers, the service's operation, and people reporting privacy or security concerns.",
        },
        {
          type: 'paragraph',
          text: 'California Notice at Collection (CCPA/CPRA): In the preceding 12 months and at collection, the categories above correspond to California Civil Code § 1798.140 statutory categories: (A) Identifiers (account subject, email, IP address, workspace/request IDs); (B) California Customer Records and payment linkage (billing-owner authority, orders, recharge attempts, processing fees, saved-card ISO-2 country code); (D) Commercial information (quotes, prepaid credit purchases, usage ledger and generation history); (F) Internet or other electronic network activity information (functional cookies and registered API/MCP route interactions); (H) Audio, electronic, visual or similar information (prompts, reference images/video/audio and generated outputs); and (L) Sensitive personal information (account authentication credentials/tokens, and any user-submitted media depicting a human face or voice processed on your instructions). Purposes of collection and use are detailed in section 4, disclosures to service providers and customer-selected providers in section 6, and retention criteria in section 8. OpenGen does not “sell” or “share” personal information (including of minors under 16) for cross-context behavioral advertising. Under Cal. Civ. Code § 1798.121, OpenGen uses and discloses Sensitive Personal Information solely to perform the services reasonably expected by an average user, ensure security and integrity, prevent fraud/abuse, and comply with legal obligations — never to infer characteristics about individuals.',
        },
        {
          type: 'paragraph',
          text: 'Some information is necessary for a requested feature: verified identity for account access, required model inputs for generation, a destination for an authorized webhook, and payment information for a credit purchase. Without it, that feature may not work. Optional labels, support context and model parameters need not be supplied unless the workflow requires them. Do not submit unnecessary sensitive information, complete payment details or passwords. Use designated connection controls for provider secrets.',
        },
        {
          type: 'paragraph',
          text: 'Stripe handles payment and saved-card entry. Our payment journal stores minimized customer, setup, mandate and transaction linkage/status plus the saved card two-letter ISO country code for processing-fee calculation, never full card numbers, CVC, bank credentials or raw payment webhook bodies. Stripe separately handles information required for its payment, authentication, fraud-prevention and legal functions.',
        },
      ],
    },
    {
      id: 'section-4',
      title: '4. Purposes, automated checks and legal bases',
      blocks: [
        {
          type: 'paragraph',
          text: 'We use information for the purposes below. Where EEA, UK or Swiss data-protection law requires a legal basis under GDPR Article 6, the applicable basis depends on the information, relationship and activity; service use is not blanket consent to every purpose.',
        },
        {
          type: 'table',
          columns: ['Purpose', 'Basis where applicable (including EEA/UK GDPR Art. 6)'],
          rows: [
            [
              'Authenticate, manage a workspace, and provide requested generation, recovery and delivery',
              "Performance of a contract with you (Art. 6(1)(b)) where necessary for that contract; legitimate interests in operating an authorized organizational service (Art. 6(1)(f)) for organizational users who are not individual contracting parties, subject to balancing; the customer's documented instructions where we act as its processor",
            ],
            [
              'Record prices/usage, prevent duplicate paid work, reconcile costs/payments and provide support',
              'Performance of a contract (Art. 6(1)(b)) where applicable; legitimate interests in reliable service and accurate accounting records (Art. 6(1)(f)), subject to required balancing',
            ],
            [
              'Enforce access, run bounded media/safety validation, detect misuse, investigate incidents and protect users/systems/rights',
              'Legitimate interests in security, abuse prevention and network integrity (Art. 6(1)(f)), and compliance with legal obligations (Art. 6(1)(c)) where applicable',
            ],
            [
              'Keep required financial records, report unlawful CSAM/CSAE where mandated, comply with binding process and address legal claims',
              'Compliance with legal obligations (Art. 6(1)(c)); establishing, exercising or defending legal claims where applicable',
            ],
            [
              'Carry out a genuinely optional use for which we request consent',
              'Consent for that stated use (Art. 6(1)(a)), which may be withdrawn at any time without affecting prior lawful processing',
            ],
          ],
        },
        {
          type: 'paragraph',
          text: 'Bounded automated validation and safety checks: OpenGen uses automated schema and route checks, isolated media-container inspection (ffprobe) to verify output integrity/duration, optional C2PA Content Credentials verification where available, rate/spending guards, and abuse-prevention controls, while selected upstream providers run their own automated safety filters. Apparent child sexual exploitation and abuse material (CSAM/CSAE) is preserved as legally required and reported to NCMEC and competent authorities.',
        },
        {
          type: 'paragraph',
          text: "We consider the information's nature and effects on people when relying on legitimate interests. Contact legal@opengen.dev about the applicable basis or to object where available. A customer's basis for its content is distinct from our obligations when processing on its instructions.",
        },
        {
          type: 'paragraph',
          text: "This notice grants no general right to train models on private generations, publish them in a gallery, use them in marketing, sell them as a content collection or otherwise reuse personal information for unrelated purposes. Selected provider terms still matter; our limited uses do not establish every upstream provider's practices.",
        },
      ],
    },
    {
      id: 'section-5',
      title: '5. Private workspaces, BYOK vs managed routes, clients and delivery',
      blocks: [
        {
          type: 'paragraph',
          text: 'Generations are private to the owning workspace and authorized identities/scopes. Authorized members, API keys and agent grants can access information allowed by their permissions. Team privacy is not creator-only privacy. Administrators can manage access and inspect activity available to their role. Necessary operational processing by OpenGen and its service providers still occurs.',
        },
        {
          type: 'paragraph',
          text: "Managed vs Bring Your Own Key (BYOK) routes: When a generation runs on an OpenGen-managed route, OpenGen transmits the necessary prompt, reference media and parameters to the selected regional model deployment using OpenGen's upstream provider account, subject to that route's disclosed provider terms and data handling. When a generation explicitly uses your workspace's own connected provider credential (BYOK), OpenGen decrypts that stored credential server-side solely to submit your request and recover the same accepted task (never returning your raw secret to browsers or agents), and the selected provider processes the request directly under your own account and direct agreement/privacy relationship with that provider.",
        },
        {
          type: 'paragraph',
          text: 'An assistant or other client receives what you send through it and the authorized results returned to it. Its own history and handling are separate. Revoking its OpenGen grant limits future access; it does not delete copies already received. Configured webhooks/destinations likewise receive information needed for authorized delivery. Review who controls them before connecting.',
        },
        {
          type: 'paragraph',
          text: 'Private delivery can issue a short-lived bearer link usable by its holder until expiry. The standard media signer defaults to 15 minutes and permits no more than one hour; the returned expiry controls the particular link. Expiry limits link access, not file retention. Key/grant revocation does not necessarily recall issued links or downloaded copies. Do not publish private result links.',
        },
      ],
    },
    {
      id: 'section-6',
      title: '6. Recipients and generation providers',
      blocks: [
        {
          type: 'paragraph',
          text: 'We disclose information needed for the function, authorized workflow or other purpose explained here:',
        },
        {
          type: 'table',
          columns: ['Recipient', 'Function and relevant information'],
          rows: [
            [
              'Cloudflare',
              'Domain/DNS and edge delivery/protection of opengen.dev traffic, including relevant request and connection information',
            ],
            [
              'Vercel',
              'Frontend hosting and authorized request forwarding, including request information and data carried by that interaction',
            ],
            [
              'Google Cloud Platform',
              'Backend, database and private object storage for accounts, workflows, media and operational records',
            ],
            [
              'Stripe',
              'Payment entry/processing, transaction status, refunds, disputes and related security/legal functions',
            ],
            [
              'Google Workspace',
              'Support/privacy/legal email, including correspondence and information the sender supplies',
            ],
            [
              'Google sign-in',
              'Authentication and identity claims needed to establish the OpenGen session; the login flow requests OpenID, profile and email scopes',
            ],
            [
              'Selected model provider/reseller and its processing chain',
              'Prompts, references, parameters and task information needed for the authorized operation, and its response/operational records',
            ],
            [
              'Your organization, authorized client or destination',
              'Information its membership, scope or your delivery instruction authorizes it to receive',
            ],
          ],
        },
        {
          type: 'linkedParagraph',
          parts: [
            'A recipient may have a different role for its own account, security, payment or legal functions. This list does not make every recipient a subprocessor for every purpose. Public information is available from ',
            {
              label: 'Cloudflare',
              href: 'https://www.cloudflare.com/privacypolicy/',
            },
            ', ',
            {
              label: 'Google Cloud',
              href: 'https://cloud.google.com/terms/cloud-privacy-notice',
            },
            ', ',
            {
              label: 'Vercel',
              href: 'https://vercel.com/legal/privacy-notice',
            },
            ' and ',
            {
              label: 'Stripe',
              href: 'https://stripe.com/privacy',
            },
            '; their notices have their own scope and do not replace customer-content processing agreements.',
          ],
        },
        {
          type: 'paragraph',
          text: "Model pages link original providers and distinguish model author, provider/reseller and established regional information. Official identifies an author's offering, not endorsement of OpenGen; Verified records a bounded live test, not a privacy certification. Content-use, retention, security, locations and subproviders differ by route/account. Private OpenGen delivery does not guarantee universal upstream no-training treatment, private upstream URLs or zero retention. Contact us before submitting information needing a particular protection. Using your own provider key does not remove that provider's direct terms.",
        },
        {
          type: 'paragraph',
          text: 'We may disclose relevant information when legally required or reasonably necessary for security/fraud investigations, mandatory child-safety reporting, rights protection or legal claims. Disclosure remains tied to that purpose. These operational disclosures do not authorize sale or unrelated advertising use of private generation content.',
        },
        {
          type: 'paragraph',
          text: 'We may provide the minimum information needed to professional advisers, such as lawyers, accountants, auditors or insurers, for advice, accounting, claims or compliance, subject to appropriate confidentiality and legal duties. This is not permission for unrelated access to private generation content.',
        },
        {
          type: 'paragraph',
          text: 'If we evaluate or complete a merger, financing, reorganization, sale or similar business transaction, we may disclose information necessary for that process under appropriate confidentiality and access safeguards, using aggregated or de-identified information where feasible. We will require recipients to protect the information and any successor to honor applicable privacy commitments, and provide notice or choices where required. This does not authorize selling private generations as a content collection or expanding their use to unrelated training or advertising.',
        },
        {
          type: 'paragraph',
          text: 'OpenGen will not sell personal information or share it for cross-context behavioral advertising, as those terms are defined by applicable privacy law. Our current website and application do not use advertising trackers or session-replay integrations. Necessary service disclosures are described above and remain subject to their applicable purpose and restrictions. Independent providers can have separate practices, but those practices do not authorize OpenGen to make a disclosure prohibited by this commitment or applicable law.',
        },
      ],
    },
    {
      id: 'section-7',
      title: '7. Cookies, browser storage and Global Privacy Control',
      blocks: [
        {
          type: 'paragraph',
          text: 'Our browser application uses functional cookies and recovery storage:',
        },
        {
          type: 'table',
          columns: ['Item', 'Purpose and lifetime'],
          rows: [
            [
              'og_session cookie',
              'Signed-in session; configured for up to 12 hours and cleared on sign-out',
            ],
            [
              'og_login_intent cookie',
              'Signed temporary notice/Continue state containing the server-selected Terms snapshot and optional pending agent-authorization context. HttpOnly, SameSite=Lax and Secure on HTTPS; configured for up to 600 seconds. Cleared on validated Continue, at the sign-in callback, or for an invalid/expired sign-in intent; other failures can leave it until expiry. This temporary cookie is not a durable acceptance receipt.',
            ],
            ['og_oidc cookie', 'Temporary login transaction; configured for 10 minutes'],
            [
              'og_mcp_consent cookie',
              'Pending agent authorization through sign-in/consent; configured for 10 minutes',
            ],
            [
              'Workspace-bound session storage',
              'Playground drafts, request/recovery identities, job/result/lineage information and comparison approval; retained in the tab session until removed or it ends, subject to browser restore behavior',
            ],
            [
              'Local storage',
              'Workspace-scoped payment-order recovery and saved-card setup-recovery keys (cleared once an authenticated read confirms a terminal order or setup status), certain completed comparison identifiers and a random cross-tab session-change signal; persists until the application clears the record or you clear site data',
            ],
          ],
        },
        {
          type: 'paragraph',
          text: 'Authentication cookies are HttpOnly, SameSite=Lax and Secure on HTTPS. Browser payment and saved-card setup recovery in local storage is limited to workspace-scoped order, setup, amount and duplicate-prevention identifiers — never card numbers, CVC, provider keys or checkout links — and is cleared once an authenticated read confirms a terminal order or setup status. Scoped 3D Secure confirmation secrets used during card authentication recovery remain in memory only and are never written to browser storage or application logs. Browser records or Stripe redirects do not themselves prove payment, mandate activation or generation acceptance.',
        },
        {
          type: 'paragraph',
          text: 'Browser controls can clear or block cookies/storage. This can sign you out, remove local drafts or prevent safe recovery/funding. It does not delete server-side jobs, media or financial records. On a shared device, clear site data when appropriate after ending your work.',
        },
        {
          type: 'paragraph',
          text: 'Global Privacy Control (GPC) and universal opt-out signals: OpenGen honors the Global Privacy Control (GPC) browser signal and other legally recognized universal opt-out preference signals without requiring an account or identity verification; in addition, OpenGen does not sell personal information, share it for cross-context behavioral advertising or run targeted advertising trackers for any visitor. Hosting, edge, sign-in and payment services can handle technical information or use their own functional/security technologies for the requested interaction; this inventory is not a promise that linked third-party pages are cookie-free or infrastructure keeps no logs. If we ever introduce optional processing requiring a choice or consent, we will provide the relevant information and controls before it begins. Contact legal@opengen.dev about cookie/storage or privacy choices.',
        },
      ],
    },
    {
      id: 'section-8',
      title: '8. Retention and deletion',
      blocks: [
        {
          type: 'paragraph',
          text: 'We keep information for its necessary purpose, considering the requested workflow, account relationship, configured controls, security risks, reconciliation, disputes and legal requirements. Lifetimes differ:',
        },
        {
          type: 'table',
          columns: ['Record', 'Criteria and limits'],
          rows: [
            [
              'References and generated media',
              'Requested workflow/history/reuse, applicable expiry/deletion controls and recovery of accepted work. The current hosted input setting assigns ready reference inputs a seven-day application expiry; accepted jobs may pin required bytes pending the actual outcome. Stored output objects become eligible for storage lifecycle deletion at an age of seven days; lifecycle processing is asynchronous, so this is not an exact day-seven deletion promise. Output availability is separate from session or link lifetime.',
            ],
            [
              'Account, session and grant records',
              'Account operation, expiry/revocation, ownership and necessary authorization/security history',
            ],
            [
              'Terms acceptance receipts',
              'Evidence of the identified agreement and related legal claims or required preservation, retained only while necessary for the justified purpose. Ordinary application operations preserve the original receipt without automatic expiry; sign-out, account closure and media cleanup do not automatically erase it. Correction/deletion requests require review, and any record retained for a justified exception remains limited to that purpose. Disposition follows our reviewed database-owner procedure and scoped operator retention record rather than a single automatic expiry timer.',
            ],
            [
              'Jobs, attempts, delivery, lineage, usage and duplicate-prevention records',
              'Original-task recovery, acceptance/delivery evidence, duplicate prevention, costs and disputes; media cleanup does not automatically erase them',
            ],
            [
              'Ledger, orders, payments, refunds and disputes',
              'Reconciliation, fraud prevention and applicable financial/legal records; corrections/refunds do not erase original transaction history',
            ],
            [
              'Support, privacy and incident records',
              'Resolution, response evidence, abuse prevention and relevant legal requirements',
            ],
            [
              'Backups, soft-delete and recovery copies',
              'Restricted recovery use and applicable rotation/expiry, distinct from removal from the active service. Current database recovery is configured for seven retained backups by count and seven days of point-in-time recovery transaction logs. Object storage has a seven-day soft-delete recovery period. These are recovery settings, not a deadline for erasing every record.',
            ],
            [
              'Cloud operational logs',
              'The configured default Cloud Logging bucket retains records for 30 days; the required bucket for 400 days. This is not a single period for every support, security, payment or provider record.',
            ],
          ],
        },
        {
          type: 'paragraph',
          text: 'An asset expiry concerns availability under that control, not simultaneous removal of metadata, backups and provider copies. Accepted-use pins and cleanup scheduling can extend the time until input bytes are physically removed. Other installations or assets without an application expiry do not acquire a deletion deadline merely because they were uploaded. Do not rely on OpenGen as your only archive or assume indefinite media availability.',
        },
        {
          type: 'paragraph',
          text: 'Authorized input-asset deletion prevents new reads/use; physical cleanup can wait while accepted work pins the bytes. It is not a general account, output or provider-deletion function. Link expiry and access revocation are also different from erasure.',
        },
        {
          type: 'paragraph',
          text: 'For other account/content/deletion requests, contact legal@opengen.dev. Describe the information/workflow and include existing identifiers if available, without unnecessarily resending sensitive files. We will assess the request, coordinate with an organization where we process on its instructions, take legally required action and explain retained information and reasons. We will communicate relevant deletion instructions to recipients where law or agreement requires. This is not instant erasure of every copy: accepted work, legitimate records, legal holds, backup rotation, independent provider duties and client downloads can affect action and timing. Information retained for an exception remains limited to that purpose.',
        },
      ],
    },
    {
      id: 'section-9',
      title: '9. International data transfers',
      blocks: [
        {
          type: 'paragraph',
          text: 'OpenGen is operated from the United States. Infrastructure, serving model providers, regional routes and authorized clients may process or access information in the United States and other countries. An API endpoint region does not establish every inference, storage, support, account, security or payment location, and unknown upstream regions are not a residency guarantee.',
        },
        {
          type: 'paragraph',
          text: 'Where EEA, UK, Swiss or other applicable law requires cross-border transfer safeguards (such as under GDPR Chapter V, Articles 45–46), the covered transfer must rely on an applicable mechanism — such as an adequacy decision (including a third-party vendor’s verified certification under the EU-U.S. Data Privacy Framework, UK Extension or Swiss-U.S. DPF where applicable to that vendor; OpenGen itself does not claim DPF certification), European Commission Standard Contractual Clauses (SCCs), the UK International Data Transfer Agreement (IDTA) or Addendum, or Swiss FDPIC adaptations, together with required supplementary measures. We do not claim every catalogued model route has executed SCCs, EU-only residency or identical protections, and service use is not consent to waive mandatory transfer safeguards.',
        },
        {
          type: 'paragraph',
          text: 'Contact legal@opengen.dev for relevant locations/safeguards or a copy/description of applicable safeguards, subject to legitimate confidentiality/security redactions. Arrange required business processing/transfer terms before submitting covered information. If a required protection is unavailable for a route, use a suitable alternative arrangement.',
        },
      ],
    },
    {
      id: 'section-10',
      title: '10. U.S. state, EEA/UK/Swiss and global privacy rights, appeals and complaints',
      blocks: [
        {
          type: 'paragraph',
          text: 'Depending on applicable law — including comprehensive U.S. state privacy statutes (such as California CCPA/CPRA, Virginia VCDPA, Colorado CPA, Connecticut CTDPA, Texas TDPSA, Oregon OCPA, Delaware DPDPA, New Jersey, Montana and similar state laws) as well as EEA GDPR, UK GDPR, the Swiss FADP and other applicable privacy laws — you may have rights to confirm processing, know/access categories and specific pieces of personal information, correct inaccuracies, request deletion, obtain a portable copy, restrict or object to processing, withdraw optional consent, limit use/disclosure of sensitive personal information, and opt out of sale, sharing, targeted advertising or profiling in furtherance of decisions that produce legal or similarly significant effects. Rights and statutory exceptions vary by jurisdiction and role.',
        },
        {
          type: 'paragraph',
          text: 'Write to legal@opengen.dev, describing the action and enough context to locate the information. You may write if someone else uploaded information about you, you lack a job ID, or you have no account. We may proportionately verify identity, authority and the records concerned; do not send passwords, API keys or complete payment details. An authorized agent or representative may submit a request with legally required proof of authority (and direct consumer confirmation where permitted by law); verification is never used to collect unrelated personal data.',
        },
        {
          type: 'paragraph',
          text: "We will not require identity verification for an opt-out (including Global Privacy Control signals) that applicable law requires us to honor without verification, or require you to create an account to exercise privacy rights. Where California's “Shine the Light” law (Cal. Civ. Code § 1798.83) applies, California residents may contact legal@opengen.dev regarding third-party direct-marketing disclosures (OpenGen does not disclose personal information to third parties for their own direct-marketing purposes).",
        },
        {
          type: 'paragraph',
          text: 'For customer-directed information, we may refer/relay a request to the responsible organization and assist as law/agreement requires. This does not remove our responsibility for information we control. We will explain an applicable denial, exception, fee or extension. We do not discriminate for exercising applicable rights, although a choice can affect a feature that genuinely needs the information.',
        },
        {
          type: 'paragraph',
          text: 'We respond within the applicable statutory deadline: under the EEA/UK GDPR, ordinarily one month from receipt (extendable by up to two additional months where legally permitted with notice within the first month); under California, Virginia, Colorado, Connecticut, Texas and similar U.S. state privacy laws, ordinarily within 45 calendar days (extendable by up to 45 additional days where permitted with prior notice and explanation). Shorter statutory deadlines control where applicable.',
        },
        {
          type: 'paragraph',
          text: "Appeals and regulator complaints: To appeal a refusal or partial decision, reply to our response or email legal@opengen.dev with “Privacy appeal” and your reason. We review appeals and provide a written decision and explanation within the applicable statutory appeal period (for example, within 45 to 60 days under applicable U.S. state privacy laws). If an appeal is denied or unresolved, U.S. residents may contact their state Attorney General (or the California Privacy Protection Agency), and EEA, UK or Swiss individuals may lodge a complaint at any time with their local EEA supervisory authority, the UK Information Commissioner's Office (ICO) or the Swiss Federal Data Protection and Information Commissioner (FDPIC). No OpenGen contract waives a mandatory complaint or judicial remedy.",
        },
      ],
    },
    {
      id: 'section-11',
      title: "11. Children's privacy (18+, COPPA under-13 and GDPR under-16)",
      blocks: [
        {
          type: 'paragraph',
          text: "OpenGen accounts and direct service use are strictly limited to adults aged 18 or older (or the age of legal majority in your jurisdiction). OpenGen is not directed to children, and we do not knowingly collect, solicit or maintain personal information from children under 13 (as protected by the U.S. Children's Online Privacy Protection Act, COPPA) or from minors under 16 (or the applicable digital-consent age between 13 and 16 under EEA/UK data-protection laws). If we learn that a person under 18 — including any child under 13 or 16 — has created an account or submitted personal information directly, we promptly disable the account and delete that personal information, subject only to minimal retention strictly required by law or mandatory child-safety reporting. This eligibility rule does not claim routine collection of government ID documents from every adult visitor.",
        },
        {
          type: 'paragraph',
          text: "An adult's authorized workflow upload depicting a minor is distinct from a minor holding an account: the adult or developer must hold all required parental/guardian permissions, comply with applicable child-privacy and model/provider rules, enforce 18+ age-gating on any downstream application, and never submit unlawful, exploitative or prohibited material. Parents, guardians or any concerned person may report an underage account or a child's personal information to legal@opengen.dev without needing an OpenGen account.",
        },
      ],
    },
    {
      id: 'section-12',
      title: '12. Sensitive information and automated processing',
      blocks: [
        {
          type: 'paragraph',
          text: 'Content may reveal health, identity, beliefs or other sensitive matters and identify people by face or voice. A recognizable image or recording is not automatically a biometric identifier or template used to uniquely identify a person; purpose and processing matter. OpenGen does not extract or store persistent facial-recognition or voiceprint templates to identify individuals, and this notice authorizes no biometric-identification or unrelated sensitive-data use.',
        },
        {
          type: 'paragraph',
          text: 'Submit only information you are authorized to use, through a suitable route. If a legal condition or contractual protection is required, put it in place first. Providers may process differently; their rules cannot be inferred from workspace privacy. Feature-specific information, permissions or legal conditions must be addressed for that feature, not assumed from general use.',
        },
        {
          type: 'paragraph',
          text: 'Generation, media validation, routing and access controls involve automation, but creative media generation is not used by OpenGen for automated profiling or solely automated decisions producing legal or similarly significant effects on individuals. Contact legal@opengen.dev about any automated security/abuse restriction or personal data concern for human review and applicable intervention rights.',
        },
      ],
    },
    {
      id: 'section-13',
      title: '13. Security and incidents',
      blocks: [
        {
          type: 'paragraph',
          text: 'We use workspace/scoped authorization, protected session/token records, controlled credentials and private delivery to limit access. Connected provider credentials and original-attempt credential snapshots are encrypted for controlled server-side use/recovery. HTTPS protects communication to the public hosted service. Application logging is designed to redact authorization/cookie values and record bounded operational information instead of routinely logging request bodies. Infrastructure/provider logs have separate handling.',
        },
        {
          type: 'paragraph',
          text: 'These controls do not mean every field is separately application-encrypted, every recipient has identical controls, links are safe to publish, or systems are risk-free. Protect credentials and review memberships, grants and destinations. Contact support@opengen.dev for urgent access help and legal@opengen.dev for privacy/security concerns without live secrets or unnecessary private media.',
        },
        {
          type: 'paragraph',
          text: 'We investigate incidents, take appropriate containment/remediation measures and notify affected people, organizations or authorities where law or an applicable agreement requires. Timing, recipients and information depend on the duties and incident. We do not claim a certification or universal notification deadline.',
        },
      ],
    },
    {
      id: 'section-14',
      title: '14. Updates and contact',
      blocks: [
        {
          type: 'paragraph',
          text: 'This notice states its effective date at the top of the page. We will explain material changes and provide advance notice or choices where required by law before affected new processing begins. An update is not permission for unrelated use of existing private generations or a waiver of mandatory rights.',
        },
        {
          type: 'paragraph',
          text: 'legal@opengen.dev — privacy, rights requests, appeals, complaints and legal notices. support@opengen.dev — account, generation, billing, refund and service support.',
        },
      ],
    },
  ],
} satisfies LegalPolicy;

export const dataProcessingPolicy = {
  slug: 'data-processing',
  navigationLabel: 'DPA draft',
  title: 'OpenGen Business Data Processing Addendum',
  description:
    'Proposed OpenGen business data processing addendum. Template only; not executed or automatically incorporated.',
  reviewDate: '16 November 2026',
  sections: [
    {
      id: 'section-1',
      title: '1. Parties, scope and roles',
      blocks: [
        {
          type: 'paragraph',
          text: "This Addendum is between ATOMSTOBITS LABS INC., a Delaware corporation in the United States (“OpenGen”), and the business customer identified in the agreement incorporating it (“Customer”). Contact legal@opengen.dev for data-protection matters and support@opengen.dev for service assistance. Customer's authorized privacy and incident contacts are recorded in Schedule A.",
        },
        {
          type: 'paragraph',
          text: "OpenGen's business and legal-notice mailing address is ATOMSTOBITS LABS INC., 201 Folsom St, San Francisco, CA 94105, United States.",
        },
        {
          type: 'paragraph',
          text: "“Customer Personal Data” means personal information in prompts, references, generated media and customer-directed workflow context that OpenGen processes on Customer's documented instructions for the covered service. The applicable privacy/data-protection law supplies the meanings of personal data, controller, processor and personal data breach.",
        },
        {
          type: 'paragraph',
          text: 'For this processing, Customer is a controller, or a processor authorized by its controller to appoint OpenGen as a subprocessor. The actual roles and controller authority must be recorded in Schedule A. Customer retains responsibility for lawful collection, notices, legal bases and permissions for its instructions and intended use.',
        },
        {
          type: 'paragraph',
          text: 'OpenGen separately determines purposes for its own account administration, payment/accounting, fraud prevention, security and legal obligations, as described in the Privacy Notice. Those controller activities are not converted into instructed processing by this Addendum. Roles follow the actual purpose: OpenGen will not reclassify submitted content as account or security data to avoid these obligations. Protecting Customer Personal Data while providing the instructed service remains within this Addendum.',
        },
        {
          type: 'paragraph',
          text: 'Independent self-hosted installations have their own operators. This Addendum covers only the identified OpenGen-hosted processing; software licensing alone does not appoint OpenGen as processor for another deployment.',
        },
      ],
    },
    {
      id: 'section-2',
      title: '2. Covered service and documented instructions',
      blocks: [
        {
          type: 'paragraph',
          text: 'Schedules A–D define the purpose, duration, operations, data subjects/categories, security controls, authorized processing chain and any required transfer arrangement. They must describe the actual intended use, rather than authorize every possible catalog feature.',
        },
        {
          type: 'paragraph',
          text: "Customer instructs OpenGen to receive and validate supported requests; prepare and store authorized inputs; submit them to an approved route; recover the same accepted task; retrieve and privately deliver outputs; maintain necessary workflow evidence; and perform agreed support, protection, return and deletion. Customer's authorized configuration and individual requests supply instructions only within the agreed scope. A permitted fallback must remain within that scope and chain.",
        },
        {
          type: 'paragraph',
          text: 'OpenGen will process Customer Personal Data only on those instructions or as law requires. Where legally permitted, it will tell Customer before legally required processing outside the instructions. If OpenGen considers an instruction unlawful or cannot comply with an essential agreed protection, it will promptly explain and pause the affected new processing while the parties resolve it. Silence or catalog selection does not expand the instructions.',
        },
        {
          type: 'paragraph',
          text: "Customer must have authority for its end users' submissions, depicted/heard people and any onward-controller instruction. It must identify sensitive or regulated information and necessary additional safeguards before submission. A general DPA does not make an unsuitable route suitable for every kind of information.",
        },
      ],
    },
    {
      id: 'section-3',
      title: '3. Purpose limitation and confidentiality',
      blocks: [
        {
          type: 'paragraph',
          text: 'OpenGen will not use Customer Personal Data for general model training, public galleries, advertising, unrelated product development, sale or other independent content reuse. Necessary service/security handling is limited to its documented purpose. The Addendum grants no broader content license than is necessary for the covered service.',
        },
        {
          type: 'paragraph',
          text: 'OpenGen will limit access to authorized people who need it for that purpose and ensure those people are subject to an appropriate contractual or legal confidentiality obligation. Support requests should use existing identifiers and only the private material reasonably necessary to address the issue. Account administration and confidential operational handling are not permission for unrestricted staff access.',
        },
        {
          type: 'paragraph',
          text: "If applicable law treats OpenGen as a service provider or contractor for Customer Personal Data, OpenGen will use it only for the specified service/business purposes; will not sell it, share it for cross-context behavioral advertising or retain/use/disclose it outside the permitted relationship except as law permits; and will not combine it with other personal information except as permitted by that law. OpenGen will notify Customer if it can no longer meet the applicable restrictions and allow reasonable, lawful steps to verify compliance and stop/remediate unauthorized use. Entering the binding Addendum acknowledges these restrictions; it does not assert that every jurisdiction's statute applies to every customer.",
        },
      ],
    },
    {
      id: 'section-4',
      title: '4. Security',
      blocks: [
        {
          type: 'paragraph',
          text: 'OpenGen will maintain technical and organizational measures appropriate to the covered processing and risks, using the completed Schedule B as the agreed baseline. It will not materially reduce that agreed level of protection without an appropriate documented change. Necessary improvements do not require freezing one software implementation indefinitely.',
        },
        {
          type: 'paragraph',
          text: "Schedule B distinguishes evidenced implementation/configuration from contractual operating procedures to be agreed. No SOC 2/ISO certification, dedicated security organization, universal uptime, fully encrypted application field set or universal provider privacy protection is represented. A vendor's own certification is not an OpenGen certification.",
        },
        {
          type: 'paragraph',
          text: "Customer is responsible for its devices, instructions, members, issued credentials and selected external clients. OpenGen remains responsible for its own required safeguards; a customer's security duty is not a blanket exclusion of OpenGen's responsibility.",
        },
      ],
    },
    {
      id: 'section-5',
      title: '5. Approved subprocessors and generation routes',
      blocks: [
        {
          type: 'paragraph',
          text: "Customer authorizes only the in-scope subprocessors and chains recorded in the completed Subprocessor Schedule, subject to the change process below. Before giving a subprocessor access, OpenGen will put in place written obligations meeting the applicable requirements for that processing, including confidentiality, appropriate security, purpose limits and required assistance/transfer terms. OpenGen remains responsible for its subprocessors' performance of those duties as if it performed them itself, subject to lawful allocation in the underlying agreement and any overriding transfer instrument.",
        },
        {
          type: 'paragraph',
          text: "A brand name, serving endpoint, Official badge, live Verified test, provider key or public DPA link does not establish the recipient's legal role or the terms actually applicable to OpenGen's account. For each covered model route, the schedule must identify the serving provider/reseller and relevant downstream model/hosting chain, who appoints them, the covered operation/data, and required contractual and technical protections. BYOK billing alone does not decide whether a provider is OpenGen's subprocessor, Customer's direct processor or an independent recipient.",
        },
        {
          type: 'paragraph',
          text: "Excluded, unreviewed or incompatible routes are not covered simply because a customer selects them in the catalog. In particular, fal's designated Excluded Models cannot be assumed to receive its ordinary DPA/security or content-use protections. An exception must be resolved under the actual supplier terms before treating a chain as covered; an OpenGen label cannot override it.",
        },
        {
          type: 'paragraph',
          text: 'Customer-authorized clients, assistants and destinations are not automatically OpenGen subprocessors. Their handling is the responsibility of the party selecting/operating them, while OpenGen must transmit only what the authorized instruction permits.',
        },
      ],
    },
    {
      id: 'section-6',
      title: '6. Subprocessor changes and objections',
      blocks: [
        {
          type: 'paragraph',
          text: "For a proposed new in-scope subprocessor or material expansion of its processing, OpenGen will give the designated Customer contact at least 30 days' advance written notice describing the recipient, function, relevant locations and protections. Customer may object during that period on reasonable data-protection grounds by emailing legal@opengen.dev. A customer-requested route or earlier change can be specifically authorized in writing after the necessary information and safeguards are supplied; public catalog availability alone is not that authorization.",
        },
        {
          type: 'paragraph',
          text: "Changes to an approved supplier's own subprocessors follow a different notice process only where the completed Schedule C identifies the supplier, its actual notice and objection process, and Customer has expressly authorized that arrangement. OpenGen will promptly relay material notices it receives, exercise available supplier objection rights where appropriate, and preserve the information and opportunity to object required by the agreed arrangement and applicable law. A supplier's shorter notice or unilateral update does not itself amend this Addendum or authorize a new recipient. If required authorization or essential protection cannot be maintained, OpenGen will pause affected new processing or arrange a compliant alternative or termination under this section. OpenGen remains responsible under section 5. Otherwise, the thirty-day rule continues to apply.",
        },
        {
          type: 'paragraph',
          text: 'The parties will work in good faith on a suitable alternative, configuration or protection. OpenGen will not begin the objected-to new processing while the objection remains unresolved. If no compliant arrangement is reasonably available, either party may end the affected part of the service, with return/deletion and unused-paid-balance consequences under this Addendum and the credit and refund provisions of the Terms of Service. No new unapproved paid generation is authorized to repair the situation.',
        },
        {
          type: 'paragraph',
          text: 'A replacement needed urgently to comply with law or address a serious security risk can require shorter notice, but only for the necessary processing and with required contractual safeguards, prompt notice and a meaningful opportunity to object/stop affected future use. This is not a general commercial exception. Already-accepted work must be handled lawfully under its original scope; it is not permission for fresh processing through an undisclosed chain.',
        },
      ],
    },
    {
      id: 'section-7',
      title: '7. Individual rights, assistance and legal requests',
      blocks: [
        {
          type: 'paragraph',
          text: 'Taking account of the service and information available, OpenGen will provide reasonable assistance so Customer can respond to applicable requests for access, correction, deletion, restriction, portability or other protected rights. It will promptly relay a request about instructed processing to Customer unless law requires OpenGen to respond directly. OpenGen remains responsible for requests concerning its own controller processing.',
        },
        {
          type: 'paragraph',
          text: "OpenGen will assist as reasonably necessary with security obligations, breach notifications, data-protection impact assessments and required prior consultation. It will supply relevant available facts about its processing and approved chain; it does not promise access to every model's internals or act as Customer's legal adviser. Required information or protection that is unavailable must be addressed for the affected processing, not replaced by an invented assurance.",
        },
        {
          type: 'paragraph',
          text: 'For a binding authority request for Customer Personal Data, OpenGen will assess the request and disclose only what is legally required. Where permitted, it will notify Customer in time to consider available remedies and provide relevant details. Where reasonably justified and lawful, it will challenge an excessive or unlawful demand. No clause requires unlawful secrecy disclosure or delays a binding legal obligation.',
        },
        {
          type: 'paragraph',
          text: "Ordinary assistance uses available records and controls. Extraordinary custom work may require a reasonable written estimate/agreement in advance, except where charging or conditioning assistance would conflict with law, an applicable transfer instrument or OpenGen's responsibility to remedy its own breach.",
        },
      ],
    },
    {
      id: 'section-8',
      title: '8. Personal data incidents',
      blocks: [
        {
          type: 'paragraph',
          text: "OpenGen will notify Customer's designated incident contact without undue delay after becoming aware of a personal data breach affecting Customer Personal Data processed by OpenGen or its subprocessors. It will not wait for a completed forensic investigation before giving available material information and will provide meaningful updates as more becomes known.",
        },
        {
          type: 'paragraph',
          text: "Information will include, to the extent available, the nature and likely effects of the incident, affected data/people, containment or remediation steps and a contact for follow-up. OpenGen will take appropriate steps within its responsibility to contain and address the incident, preserve relevant evidence and assist Customer's required response. A routine failed generation is not necessarily a personal data breach.",
        },
        {
          type: 'paragraph',
          text: 'Customer determines its required regulator/individual notices as controller, or coordinates with its controller when acting as processor. OpenGen will coordinate where practicable, while meeting any independent legal duty of its own. Notice is not by itself an admission of fault. This draft sets no universal numeric notification SLA; any more specific agreed deadline must fit the actual response arrangements and applicable law.',
        },
      ],
    },
    {
      id: 'section-9',
      title: '9. Return, deletion and limited retained copies',
      blocks: [
        {
          type: 'paragraph',
          text: "At the end of covered service, or on a valid instruction during it, OpenGen will arrange Customer's choice of return of available Customer Personal Data in a reasonably accessible form or deletion, and deletion of remaining instructed-processing copies, except to the extent law requires retention. The completed processing schedule must describe the actual return/deletion procedure and relevant timing for active systems, accepted tasks, subprocessors and recovery copies.",
        },
        {
          type: 'paragraph',
          text: 'While resolving an instruction, OpenGen will stop new affected use and explain any practical or legal restriction. Accepted upstream tasks, pins, backups and financial records have different lifecycles; their existence is not a universal legal exemption or indefinite content-use permission. Where a task cannot immediately be stopped, OpenGen will limit further handling to what is unavoidable, lawfully permitted and necessary to carry out the agreed resolution, and inform Customer.',
        },
        {
          type: 'paragraph',
          text: 'Lawfully retained records remain protected and restricted to their retained purpose. Independent account/billing/legal records are addressed under their actual controller role and the Privacy Notice; calling a record financial does not justify retaining unrelated full content. Recovery copies must follow the documented rotation/deletion plan and not be restored for unrelated use. Restored data must again be subject to the applicable deletion instruction.',
        },
        {
          type: 'paragraph',
          text: 'On request, OpenGen will provide written confirmation of actions taken and identify categories still retained, their reason and applicable completion/rotation criteria. It will not certify deletion of all upstream or backup copies without evidence. No automatic account/output erasure feature, instant deletion or indefinite media availability is promised.',
        },
      ],
    },
    {
      id: 'section-10',
      title: '10. Demonstrating compliance and audits',
      blocks: [
        {
          type: 'paragraph',
          text: 'OpenGen will make information reasonably necessary to demonstrate compliance with this Addendum available under appropriate confidentiality and security controls. The first step is relevant documentation, completed schedules, available assessment material and answers to reasonable questions; no nonexistent independent report is promised.',
        },
        {
          type: 'paragraph',
          text: "Where that is insufficient, Customer or a qualified independent auditor bound to confidentiality may conduct a proportionate audit of the relevant processing. Routine audits are ordinarily limited to once in 12 months, on at least 30 days' notice during normal business hours. These limits do not prevent an audit required by law, a regulator or an applicable transfer instrument, or a reasonably necessary additional review following a material incident or evidence of noncompliance.",
        },
        {
          type: 'paragraph',
          text: "The parties will avoid unnecessary disruption and protect other customers' data, credentials and unrelated confidential systems. Access to shared cloud/provider facilities is subject to the lawful available audit mechanism, not a promise of physical access to every vendor. These arrangements cannot defeat mandatory audit rights. Reasonable routine Customer-requested audit costs may be Customer's responsibility if agreed in advance; remediation of OpenGen's own breach and compulsory authority access cannot be withheld merely for a commercial fee dispute.",
        },
      ],
    },
    {
      id: 'section-11',
      title: '11. International and onward transfers',
      blocks: [
        {
          type: 'paragraph',
          text: 'Before a transfer needing a legal safeguard, including relevant remote access or onward disclosure, the parties must identify the actual exporter/importer, roles, recipients, locations, purpose, applicable law and lawful transfer basis in Schedule D. If the required basis or protection is not available, the affected transfer must not begin.',
        },
        {
          type: 'paragraph',
          text: 'Where appropriate, the parties must actually complete and enter the required standard contractual clauses or another valid arrangement, including the applicable modules/options, party and processing details, security measures, subprocessor information, governing-law/forum choices required by that instrument, and relevant assessment/supplementary measures. A UK transfer may require an appropriate completed UK instrument; Swiss requirements need their applicable adaptations. Generic references do not fill these items.',
        },
        {
          type: 'paragraph',
          text: 'This draft does not incorporate SCCs as deemed executed, assert a completed UK addendum, claim DPF participation or appoint an EEA/UK representative. A vendor transfer mechanism can be used only when verified as applicable to that recipient, service and data; its brand or public policy is not proof. Customer can request relevant completed safeguards from legal@opengen.dev, subject to lawful security/confidentiality redactions.',
        },
        {
          type: 'paragraph',
          text: 'A mandatory transfer instrument takes priority over conflicting commercial provisions, including law/forum, audit or liability wording. No Delaware court clause, contractual cap or fee condition overrides rights that the applicable law or instrument protects. Endpoint region does not establish every storage, support or recipient location.',
        },
      ],
    },
    {
      id: 'section-12',
      title: '12. Term, responsibility and changes',
      blocks: [
        {
          type: 'paragraph',
          text: "This Addendum lasts for the covered processing under the actually incorporated agreement, including necessary protected return/deletion obligations after service termination. The underlying agreement governs lawful commercial risk allocation unless mandatory law or an applicable transfer instrument requires otherwise. No customer indemnity shifts OpenGen's processor obligations to Customer, and no limitation removes an individual's mandatory rights.",
        },
        {
          type: 'paragraph',
          text: "This Addendum controls a conflict concerning its instructed processing; mandatory law and an applicable overriding transfer instrument take priority. The credit and refund provisions of the Terms of Service continue to control funding/refund arithmetic, and the Privacy Notice separately describes OpenGen's own controller activities. Nothing here forfeits owed credit/refunds or expands the source-code license restrictions.",
        },
        {
          type: 'paragraph',
          text: 'Changes require an applicable agreed process and updated schedules, with meaningful information before new processing. They do not create broader content use by silence, force a new supplier into an approved chain or reduce mandatory safeguards. If essential compliance cannot be restored, affected processing must be suspended or ended through a lawful return/deletion resolution; this is not permission to abandon unknown accepted costs or forfeit owed money.',
        },
      ],
    },
    {
      id: 'schedule-a',
      title: 'Schedule A. Customer-specific processing record',
      blocks: [
        {
          type: 'paragraph',
          text: 'Complete this record in the agreement incorporating the Addendum. A row marked for completion is not an affirmative factual statement or authorization.',
        },
        {
          type: 'table',
          columns: ['Item', 'Agreed description / completion required'],
          rows: [
            [
              'Customer and authority',
              "Customer's actual legal identity, authorized accepting representative and agreement/version/date; controller or processor role, and controller authorization where Customer is a processor",
            ],
            [
              'OpenGen party/contact',
              'ATOMSTOBITS LABS INC.; legal@opengen.dev for data-protection/incident coordination, support@opengen.dev for service assistance; a designated Customer incident recipient is required',
            ],
            [
              'Service and instructions',
              'Named hosted workspace/service and approved operations, route IDs/versions/chains, payer mode and permitted fallbacks; supported generation, same-task recovery, private delivery, agreed support and return/deletion only',
            ],
            [
              'Purpose',
              "Customer's described image/video workflow and necessary service operation; no general model training or unrelated advertising/content reuse",
            ],
            [
              'Data subjects',
              'Customer personnel/contractors, end users and people depicted, heard or otherwise identified in the authorized content, only as the actual use requires',
            ],
            [
              'Data categories',
              'Authorized prompt text, images/video/associated audio where supported, parameters, private project/context fields, generated results and necessary job/delivery/lineage identifiers; linked connection information only where authorized and needed',
            ],
            [
              'Sensitive or regulated data',
              'None authorized merely by accepting a general template; identify any intended categories, lawful conditions and additional verified safeguards before that processing',
            ],
            [
              'Frequency and duration',
              'Each authorized request and necessary workflow/recovery during the agreement; post-service handling only under the agreed return/deletion and lawful retention record',
            ],
            [
              'Locations and recipients',
              'Completed Subprocessor Schedule and Schedule D; current hosting observations alone are not a complete recipient/remote-access or residency agreement',
            ],
            [
              'Return/deletion',
              "Customer's election, actual available return method and active/task/subprocessor/recovery-copy completion criteria; document lawful exceptions and controller-record distinctions",
            ],
            [
              'Contact and assistance',
              "Customer privacy and incident contacts, required request channels, agreed assistance arrangements and any applicable deadlines beyond the Addendum's baseline",
            ],
          ],
        },
      ],
    },
    {
      id: 'schedule-b',
      title: 'Schedule B. Security and lifecycle baseline for agreement review',
      blocks: [
        {
          type: 'paragraph',
          text: 'The following current application/configuration facts are evidenced as of 8 November 2026 and form a proposed baseline to reconcile with the covered deployment. They are not proof of certifications, executed vendor contracts or equal controls at every model provider.',
        },
        {
          type: 'table',
          columns: ['Area', 'Evidenced scope and limitation'],
          rows: [
            [
              'Authorization',
              'Workspace ownership/membership and issued API/agent scopes govern application access. Read and Generate authority are distinct. Authorized team members can see permitted shared records; this is not creator-only privacy.',
            ],
            [
              'Authentication/credentials',
              'The hosted sign-in uses Google identity through the configured flow. Session/API/OAuth credentials use protected records and one-way hashes according to the applicable token class; provider connections and retained original-attempt credentials are encrypted for controlled server-side use. This does not mean every prompt/metadata field is separately application-encrypted.',
            ],
            [
              'Transmission/delivery',
              'HTTPS protects public hosted access. Private result reads require authorization before short-lived bearer delivery links are issued. The standard signer defaults to 15 minutes and caps a link at one hour; returned expiry governs. Possession can permit access until expiry, so revocation is not recall of every issued link/download.',
            ],
            [
              'Logging',
              'Application logging is designed to redact authorization/cookie values and avoid routine request-body logging. Infrastructure/provider logging is separate. The observed Cloud Logging default bucket has 30-day retention; the required bucket has 400-day retention. These are not universal content-retention periods.',
            ],
            [
              'Inputs and outputs',
              "The current application input expiry setting is seven days for ready reference inputs, with accepted-use pins and cleanup behavior. The private bucket's outputs/ prefix is eligible for asynchronous lifecycle deletion at object age seven days. No bucket-wide input lifecycle was evidenced. These controls do not establish exact day-seven destruction or erase every related record.",
            ],
            [
              'Recovery copies',
              'Observed object soft-delete recovery is seven days. Cloud SQL is configured for seven retained backups by count and seven days of point-in-time recovery transaction logs. Seven backup objects is not a seven-day maximum age guarantee. Recovery does not establish instant erasure or perpetual availability.',
            ],
            [
              'Regional baseline',
              'Current backend, database and private object-storage baseline is us-central1, United States; Vercel/Cloudflare edge delivery is globally distributed. Identity, mail, supplier inference, storage/support and other processing require their own location mapping.',
            ],
            [
              'Confidential operations',
              'The binding schedule must record actual personnel confidentiality/access procedures, incident ownership, vendor obligations, change notices and return/deletion assistance for this customer. Application controls alone do not prove those arrangements were executed.',
            ],
          ],
        },
      ],
    },
    {
      id: 'schedule-c',
      title: 'Schedule C. Authorized processing chain',
      blocks: [
        {
          type: 'paragraph',
          text: 'The separately completed Subprocessor Schedule, or its specifically identified adopted replacement, records the approved brands/legal recipients, functions, data, locations, contracts/role allocation and route chain. Its proposed brand inventory is not itself executed authorization. A change under section 6 must update the actual authorized record.',
        },
        {
          type: 'paragraph',
          text: 'For each recipient, record who appoints it, the actual upstream advance-notice and objection periods, the contact receiving notices, and any alternative process expressly authorized under section 6. Distinguish the period before new processing from the period allowed to object. A blank field, supplier policy link or public list update is not authorization for a shorter process.',
        },
      ],
    },
    {
      id: 'schedule-d',
      title: 'Schedule D. Transfer completion record',
      blocks: [
        {
          type: 'table',
          columns: ['Required determination', 'Record to complete before affected transfer'],
          rows: [
            [
              'Transfer and roles',
              'Actual exporter/importer and onward recipients; controller-to-processor or processor-to-processor role where applicable; affected data, operations and remote access',
            ],
            [
              'Applicable requirement',
              'Jurisdictional law and whether the proposed processing is a restricted transfer; actual source/destination and relevant support locations',
            ],
            [
              'Basis/instrument',
              'Verified applicable adequacy or other lawful basis, or the actual completed contractual instrument/version and appropriate module/options',
            ],
            [
              'Required details',
              'Parties/authorized acceptance, competent authority where relevant, security and processing annexes, subprocessors, required instrument law/forum, and legally required supplementary details',
            ],
            [
              'Assessment and onward chain',
              'Required transfer assessment/supplementary measures and supplier/onward-transfer commitments; unresolved items cannot be assumed covered',
            ],
            [
              'Evidence and review',
              'Accepted/executed record and date, responsible contacts, verified scope and a review/change process; obtain necessary safeguards through legal@opengen.dev',
            ],
          ],
        },
        {
          type: 'paragraph',
          text: 'No record is completed by this drafting copy. Legal details required by a particular instrument must be supplied in its actual completion record; the general email contacts here do not replace them.',
        },
      ],
    },
  ],
  introduction:
    'This original proposal becomes binding only through an actually accepted or signed customer agreement expressly incorporating its identified version, with the required processing, security, subprocessor and applicable transfer schedules completed. Viewing this document, using an API/MCP tool, selecting a catalog model or purchasing credit does not execute it. It does not announce an enterprise plan or establish coverage for every route.',
} satisfies LegalPolicy;

export const subprocessorsPolicy = {
  slug: 'subprocessors',
  navigationLabel: 'Subprocessors draft',
  title: 'OpenGen Business Subprocessor Schedule',
  description:
    'Proposed OpenGen business subprocessor schedule. Template only; not executed supplier authorization.',
  reviewDate: '16 November 2026',
  sections: [
    {
      id: 'section-1',
      title: '1. Proposed service inventory',
      blocks: [
        {
          type: 'paragraph',
          text: "Only the functions processing Customer Personal Data on the customer's instructions belong in the DPA chain. A vendor can have a separate role for its own or OpenGen's account, billing, security or legal purposes. The role follows the activity and agreement, not the brand alone.",
        },
        {
          type: 'table',
          columns: [
            'Verified brand',
            'Potential instructed-content function and information',
            'Location / contractual completion',
          ],
          rows: [
            [
              'Google Cloud Platform',
              'Hosted backend, database and private object storage handling authorized generation content, workflow records and necessary workspace context; relevant infrastructure services for that processing',
              'Current OpenGen backend/database/private-storage baseline: us-central1, United States. Confirm the actual contracting recipient, applicable services/processing terms, remote support and onward locations; the deployment region is not a universal Google location promise.',
            ],
            [
              'Vercel',
              'Frontend hosting and authorized request forwarding; Customer Personal Data carried by those interactions and necessary technical records, to the extent processed for the covered service',
              'Globally distributed frontend/edge delivery; complete the actual recipient/terms and relevant deployment, logging and support locations. No exclusive country or executed transfer arrangement is inferred.',
            ],
            [
              'Cloudflare',
              'Domain/DNS and edge delivery/protection. Where covered traffic traverses the configured edge, map request/connection information and carried Customer Personal Data; DNS alone does not make it a generation-content processor.',
              'Globally distributed edge; complete the actual recipient, enabled functions, data/support locations and terms. Distinguish independent security purposes from instructed processing.',
            ],
            [
              'Google Workspace',
              "Mail service used for support/privacy/legal correspondence; Customer Personal Data supplied for authorized support where necessary, separate from OpenGen's own correspondence/rights-record purposes",
              'Confirm the actual recipient, tenant/service terms, relevant storage/support locations and retention/access controls. Use identifiers first; do not routinely send unnecessary media or credentials.',
            ],
            [
              'Approved generation route chain',
              'The specific serving provider/reseller, model host and necessary downstream recipient processing the authorized prompts, references, parameters, outputs and task information',
              'Complete section 3 for each covered route. Neither this row nor a public catalog/provider listing authorizes every supplier or model.',
            ],
          ],
        },
        {
          type: 'paragraph',
          text: 'Brand names deliberately do not substitute for unverified contracting entities. No operator project IDs, private asset IDs, credentials or customer content belong in the published inventory. The actual contracting parties and required transfer details belong in the completed customer record.',
        },
      ],
    },
    {
      id: 'section-2',
      title: '2. Related services with separate roles',
      blocks: [
        {
          type: 'table',
          columns: ['Service/category', 'Classification limit'],
          rows: [
            [
              'Google sign-in',
              "Identity/account authentication and claims used to establish the OpenGen session. Google has its own identity/account relationship; OpenGen's own account processing is described in the Privacy Notice. This is not automatically an OpenGen generation-content subprocessor or an assertion that all Google functions have one role.",
            ],
            [
              'Stripe',
              'Payment entry/processing, transaction status, refunds, disputes and associated security/legal functions under the applicable payment arrangements. Payment services can involve processor and independent-controller roles by purpose. Stripe is not made an instructed-generation-content subprocessor merely because it funds the workspace; no routine prompt/media transfer for payment is intended.',
            ],
            [
              'Customer organization, selected assistant/client, webhook or destination',
              "Chosen/operated by Customer or its authorized user; it receives information under the authorized grant/delivery instruction. It is not automatically retained as OpenGen's subprocessor. Its own data handling and any Customer appointment must be addressed separately.",
            ],
          ],
        },
        {
          type: 'paragraph',
          text: 'If a related service actually performs additional instructed processing, document that function and legal role rather than relying on this classification to exclude it. Conversely, listing an account/payment recipient does not convert its independent purposes into processor instructions.',
        },
      ],
    },
    {
      id: 'section-3',
      title: '3. Required record for each eligible generation chain',
      blocks: [
        {
          type: 'paragraph',
          text: 'The accepted customer record must contain:',
        },
        {
          type: 'table',
          columns: ['Field', 'Required actual scope'],
          rows: [
            [
              'Route identity',
              'Exact model/variant, operation, serving route/deployment/region and version as relevant; permitted payer mode and fallback chain',
            ],
            [
              'Recipients and appointment',
              'Serving provider/reseller and downstream model/hosting recipients; verified legal parties and which party appoints each, including any Customer-direct BYOK relationship',
            ],
            [
              'Information and purpose',
              'Inputs, generated outputs and task/operational data actually transferred; required content moderation/recovery handling and any separate-controller use',
            ],
            [
              'Contract coverage',
              "Applicable processor/subprocessor obligations, confidentiality/security, onward recipients and assistance/deletion rights for OpenGen's actual account and model; evidence of required supply/reseller permission",
            ],
            [
              'Exclusions and settings',
              'Any model/account exclusions, training or other data-use exception, public/CDN access defaults and actual required privacy settings; unresolved incompatible terms cannot be silently labeled covered',
            ],
            [
              'Locations and transfers',
              'Established inference/storage/support/remote-access locations, unknown items, applicable completed transfer basis and onward protection; endpoint location alone is insufficient',
            ],
            [
              'Lifecycle',
              'Actual input/output/metadata retention, cancellation/recovery constraints and return/deletion process, including what can be instructed downstream',
            ],
            [
              'Authorization/evidence',
              "Customer's documented authorization, relevant contract/configuration evidence, review date, contacts and material-change/objection handling",
            ],
            [
              'Notice process',
              'For each appointed recipient, the actual advance-notice and objection periods, who receives notices, who appoints onward recipients, and any supplier-internal alternative expressly authorized under DPA section 6; a shorter objection window is not itself an advance-notice period',
            ],
          ],
        },
        {
          type: 'paragraph',
          text: 'An Official label concerns model authorship/first-party offering; Verified concerns a bounded execution test. Neither certifies DPA coverage, confidentiality, zero retention, residency or supplier permissions. A qualification profile or owned test fixture is not a signed processing chain.',
        },
        {
          type: 'linkedParagraph',
          parts: [
            "For fal-backed routes, the applicable API supplement distinguishes designated Excluded Models, including “Pending Enterprise Ready,” from its ordinary stated content-use/security/DPA coverage. Check the actual model/account designation and contract. Do not generalize one eligible endpoint's protection to the entire provider family. ",
            {
              label: 'fal API Services, §2',
              href: 'https://fal.ai/legal/api-services',
            },
          ],
        },
      ],
    },
    {
      id: 'section-4',
      title: '4. Changes and access to the completed record',
      blocks: [
        {
          type: 'paragraph',
          text: "The DPA's section 6 governs proposed changes, information, the applicable notice and objection process expressly recorded under that section, and narrow urgent exceptions. Its thirty-day rule remains the default; a different supplier-internal process requires the specific information and express Customer authorization described there. A Customer-requested addition may be authorized specifically in writing once the necessary facts and protections are available. Updating a catalog or this proposed inventory alone does not amend the authorized customer chain.",
        },
        {
          type: 'paragraph',
          text: 'Request the relevant completed schedule/safeguards or object to a notified change through legal@opengen.dev. support@opengen.dev handles service assistance. Appropriate confidentiality/security redactions can protect other customers and sensitive controls without defeating required information or audit rights.',
        },
      ],
    },
  ],
  introduction:
    'This schedule accompanies the proposed Business Data Processing Addendum. It becomes the authorized record only when its actual legal recipients, scope and required details are completed and incorporated into an accepted/signed customer agreement. Verified brands/functions below are an inventory for that work, not proof that their contracts, transfer arrangements or every underlying service are covered.',
} satisfies LegalPolicy;

export const legalPolicies: readonly LegalPolicy[] = [
  termsPolicy,
  privacyPolicy,
  dataProcessingPolicy,
  subprocessorsPolicy,
];

/** HTML and the agent-readable response use this same explicit policy body. */
export function legalPolicyMarkdown(policy: LegalPolicy): string {
  return [
    `# ${policy.title}`,
    `> ${legalDraftNotice}`,
    `Review date: ${policy.reviewDate}`,
    ...(policy.introduction ? [policy.introduction] : []),
    ...policy.sections.map((section) =>
      [
        `## ${section.title}`,
        ...section.blocks.map((block) => {
          if (block.type === 'paragraph') return block.text;
          if (block.type === 'linkedParagraph')
            return block.parts
              .map((part) => (typeof part === 'string' ? part : `[${part.label}](${part.href})`))
              .join('');
          if (block.type === 'list') return block.items.map((item) => `- ${item}`).join('\n');
          const row = (cells: readonly string[]) => `| ${cells.join(' | ')} |`;
          return [
            row(block.columns),
            row(block.columns.map(() => '---')),
            ...block.rows.map(row),
          ].join('\n');
        }),
      ].join('\n\n'),
    ),
    '',
  ].join('\n\n');
}
