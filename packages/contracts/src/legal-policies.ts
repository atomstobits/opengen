/** Proposed copy only. Adoption and an effective date require separate review. */
export type LegalLinkPart = string | { label: string; href: string };

export type LegalBlock =
  | { type: 'paragraph'; text: string }
  | { type: 'linkedParagraph'; parts: readonly LegalLinkPart[] }
  | { type: 'list'; items: readonly string[] }
  | { type: 'table'; columns: readonly string[]; rows: readonly (readonly string[])[] };

export interface LegalPolicy {
  slug: 'terms' | 'refunds' | 'privacy' | 'data-processing' | 'subprocessors';
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
  title: 'OpenGen Hosted Terms of Service — proposed version 4',
  description: 'Proposed OpenGen hosted Terms of Service. Draft for review, not yet effective.',
  reviewDate: '9 November 2026',
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
          text: "These Terms form an agreement when you affirmatively accept the identified version through an account, funding or other clearly presented acceptance process. You must be at least 18, have the capacity required by applicable law, and have authority to accept for any organization you represent. Do not accept for an organization without that authority. A workspace member's technical permission does not necessarily give that member authority to change the organization's contract.",
        },
        {
          type: 'paragraph',
          text: "An OAuth scope or agent permission authorizes only the access it describes. It does not by itself accept unidentified terms, authorize a credit purchase or recurring card charge, or expand the delegate's contractual authority. Browsing the catalog does not purchase a service or grant an agent access.",
        },
        {
          type: 'paragraph',
          text: 'For legal, privacy and rights requests, contact legal@opengen.dev. For account, generation, billing and refund support, contact support@opengen.dev.',
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
          text: 'These Terms and the Prepaid Credit and Refund Policy govern the hosted service. The Privacy Notice explains our handling of information and available controls. Route-specific model licenses, provider terms and required acceptable-use policies govern use of the corresponding model or provider. Their identification does not mean OpenGen has obtained every permission on your behalf.',
        },
        {
          type: 'paragraph',
          text: "Mandatory law takes priority. A separately signed agreement or data-processing agreement controls its covered subject. The credit policy controls OpenGen funding, balance and refund arithmetic. An accepted quote and job approval control that job's pricing terms and basis, whether a price is fixed or estimated, payer, spending cap and request constraints. These Terms govern the general hosted relationship; the Privacy Notice describes our data handling; applicable provider/model terms control the corresponding model use. General documentation or a later update does not silently replace an accepted request commitment. No document gives OpenGen rights it lacks upstream, reduces mandatory rights, forfeits money actually owed or restricts the published software license.",
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
          text: 'We and the relevant rights holders retain rights in the hosted interface, documentation, branding and service technology, except for rights expressly granted under a software license. You may identify an accurate integration with OpenGen, but may not imply our endorsement, use our branding deceptively or claim ownership of our marks. This does not transfer your rights in inputs or outputs to us.',
        },
        {
          type: 'paragraph',
          text: 'Published source code and its dependencies have their own licenses. For software released under Apache License 2.0, that license governs copying, modification, redistribution and independent self-hosting. These hosted Terms do not restrict those rights, prohibit lawful forks or competing independent deployments, or make us the operator of another installation. The software license does not supply access to our hosted servers, customer data, provider accounts or trademarks. Calls from a self-hosted installation to our hosted service remain subject to the hosted agreement and issued permissions.',
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
          text: "A workspace can authorize a person, application, CLI or AI agent to act within stated scopes and limits. Read access alone does not authorize generation. Generate access can spend the selected workspace's available balance or use an explicitly selected provider account. An agent can make an unwanted request while acting within a valid grant, so review its permissions, instructions and spending controls.",
        },
        {
          type: 'paragraph',
          text: 'Delegation does not authorize a new credit purchase, automatic recharge or a broader grant. Only an authorized payer may approve funding. We attribute activity within a valid grant to its workspace, while preserving rights concerning unauthorized payments and our own access-control, security or billing errors. A report of compromise does not establish whether an earlier upstream task was accepted; that question still requires recovery and reconciliation.',
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
          text: 'Review the applicable model license, provider terms and required use policies before selecting a route. For your own provider key, your provider account and direct billing terms also apply. Ensure your authorized members and end users receive and comply with the applicable restrictions. A catalog listing or payment grants no rights that the relevant rights holder has not granted.',
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
          text: 'You keep the rights you hold in prompts, references and other submitted material. Obtain the permissions required for processing and intended use, including copyright, privacy, publicity, likeness and voice permissions. Public availability alone does not establish those permissions. Do not submit material you are not entitled to delegate for the requested processing.',
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
      id: 'section-8',
      title: '8. Prices, prepaid credit and manual funding',
      blocks: [
        {
          type: 'paragraph',
          text: "Managed usage draws on the selected workspace's USD prepaid balance under the Prepaid Credit and Refund Policy. Direct provider billing through your own key is separate. We disclose the applicable price basis, fees, taxes and reservation or budget information before the corresponding approval. A quote is an estimate unless expressly offered as a fixed price. Any separate fee or customer overrun rule requires disclosure before authorization.",
        },
        {
          type: 'paragraph',
          text: 'A reservation temporarily reduces available credit; it is not a final usage charge or cash refund. Unknown acceptance or cost requires reconciliation. An error, cancellation request, expired upstream URL or recovered delivery does not by itself prove zero provider cost or a settled charge. Preserve the job ID and resume the original task rather than blindly authorize another paid generation.',
        },
        {
          type: 'paragraph',
          text: "Funding requires the authorized payer's approval of that purchase. Saving a payment method, granting Generate access or exhausting a balance does not authorize another card charge, subscription or automatic recharge. The current credit policy, not a generic permission in these Terms, governs unused purchased-credit refunds and any promotional conditions.",
        },
        {
          type: 'paragraph',
          text: 'Reservation release and cash refund are separate operations. Released available credit can subsequently be refunded with the corresponding balance adjustment; it cannot also remain available to spend or be refunded twice. Suspension, a claim under these Terms or a liability limit below does not forfeit a valid unused balance or replace reconciliation with an invented zero cost.',
        },
      ],
    },
    {
      id: 'section-9',
      title: '9. Acceptable use and applications for end users',
      blocks: [
        {
          type: 'paragraph',
          text: "Do not use OpenGen to break the law or another person's rights. Prohibited activity includes child sexual exploitation, nonconsensual intimate imagery, fraud, harmful impersonation, unlawful threats or harassment, malware, unauthorized system access, abusive unsolicited messaging and infringement of intellectual-property or privacy rights.",
        },
        {
          type: 'paragraph',
          text: "Do not obtain another workspace's data, use credentials you are not entitled to use, evade spending or access controls, conceal unauthorized automated traffic or bypass provider safety, eligibility or rate restrictions. Do not put secrets in prompts, public feedback or support messages. Connected keys must be credentials you may lawfully delegate, not stolen accounts or unauthorized access for resale.",
        },
        {
          type: 'paragraph',
          text: 'Do not attack or deliberately overload the hosted service, scan or probe its security without authorization, escape an execution boundary or use its infrastructure to reach unrelated destinations. Ordinary use of documented APIs, MCP and CLI within issued limits is permitted. These restrictions do not prohibit authorized security research or testing your own lawful independent deployment under its software license.',
        },
        {
          type: 'paragraph',
          text: "For a suspected vulnerability, stop before accessing other people's data or causing further disruption and report it privately to support@opengen.dev or an available repository private-security channel. Share the minimum information needed to investigate, without live credentials or unnecessary private media. Coordinate testing and disclosure responsibly; reporting alone does not authorize further access. This paragraph creates no bounty, guaranteed remediation deadline or indefinite restriction on lawful protected disclosure.",
        },
        {
          type: 'paragraph',
          text: 'If you build an application for others, give them accurate notice of the applicable route restrictions, obtain the permissions required for their inputs, and use reasonable controls to prevent prohibited use.',
        },
        {
          type: 'paragraph',
          text: 'Do not present generated output as human-created where that would mislead people or violate applicable law or provider requirements.',
        },
        {
          type: 'paragraph',
          text: 'You may build applications and agent workflows within the permissions you hold. That does not override an upstream restriction or add restrictions to the published source license. Do not claim endorsement or an official relationship you do not have. OpenGen may investigate reports and restrict activity under section 13; a prohibition is not a promise that every violation will be detected before processing.',
        },
      ],
    },
    {
      id: 'section-10',
      title: '10. Export, sanctions and territorial restrictions',
      blocks: [
        {
          type: 'paragraph',
          text: 'Use the service only where and as permitted by applicable export-control, sanctions and other trade laws. Do not use it for a person, entity, destination or purpose to which providing the service is prohibited. Do not misrepresent relevant eligibility or use a proxy, alternate account or intermediary to evade an applicable legal or provider/model geographic or entity restriction.',
        },
        {
          type: 'paragraph',
          text: "Provider availability can be narrower than the locations in which OpenGen's website is accessible. A listed endpoint region does not make a restricted model available to every person there. We may request information reasonably needed to confirm eligibility or pause new activity when law or a provider requires it. Restrictions can differ by route.",
        },
      ],
    },
    {
      id: 'section-11',
      title: '11. API changes, previews and compatibility',
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
      id: 'section-12',
      title: '12. Rights, infringement and safety reports',
      blocks: [
        {
          type: 'paragraph',
          text: 'Send intellectual-property, privacy, likeness or unlawful-content reports to legal@opengen.dev. Identify the right or safety issue, the affected work or person, the relevant OpenGen job/asset or other location, your contact information and why you are entitled to report it. Explain the basis of the claim and provide supporting information in good faith. Private material can be identified privately; do not publish a bearer link, API secret or unnecessary sensitive media to make a report.',
        },
        {
          type: 'paragraph',
          text: 'We may request information needed to verify and act on a report. We can restrict access, preserve necessary evidence, contact the relevant account holder and remove or disable material where justified or required by law. We will limit disclosure of private information to what is necessary for the lawful process and applicable handling. A plausible urgent safety issue can require action before a full investigation finishes.',
        },
        {
          type: 'paragraph',
          text: 'If your content or access was restricted by mistake, contact legal@opengen.dev with the affected identifier, an explanation and relevant evidence. We will review the challenge and any required response process. We do not promise restoration while a legal prohibition remains or merely because someone supplies a claimed license. Formal notices and counter-notices may require additional elements under applicable law.',
        },
        {
          type: 'paragraph',
          text: 'Repeated substantiated infringement or serious/repeated rights abuse can lead to termination under section 13. Deliberately false or abusive reports also violate these Terms. Where a formal statutory procedure applies, we will handle notices, challenges and required responses under that procedure.',
        },
      ],
    },
    {
      id: 'section-13',
      title: '13. Suspension, termination and effects',
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
          text: 'Unused purchased credit and refunds remain governed by the credit policy and mandatory rights; closure or breach is not automatic forfeiture. If we end the relationship without cause or withdraw the paid service so that you cannot reasonably use your remaining purchased balance, we will return the unused paid remainder after accepted-cost reconciliation even if the voluntary refund-request window has closed. Media and records are handled under the Privacy Notice, with necessary legal and recovery limits. Notice/cure periods do not delay a refund or other remedy that must be provided sooner.',
        },
      ],
    },
    {
      id: 'section-14',
      title: '14. Service warranties and output review',
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
      id: 'section-15',
      title: '15. Liability limits and preserved remedies',
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
          text: 'These limits do not reduce money refunds, restoration of unused purchased credit, release/correction of improper holds or debits, or other financial amounts actually owed under the credit policy or applicable law. They do not turn unresolved cost into a final debit or permit us to keep money we must return. The credit policy still determines the financial correction; damages for a separate claim are a different question.',
        },
      ],
    },
    {
      id: 'section-16',
      title: '16. Bounded third-party claim responsibility',
      blocks: [
        {
          type: 'paragraph',
          text: 'If you use OpenGen in business, you will reimburse us for reasonable amounts finally awarded to a third party, or agreed in a settlement approved as below, to the extent a claim is caused by content you lacked the necessary rights to submit or your unlawful use or material breach of sections 6, 9 or 10. This includes reasonable defense costs for that claim. It does not cover a claim merely because your account or output appears in it.',
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
      id: 'section-17',
      title: '17. Disputes, governing law and courts',
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
      id: 'section-18',
      title: '18. Electronic notices and Terms changes',
      blocks: [
        {
          type: 'paragraph',
          text: 'We may send service and contract notices to the verified account/workspace contact, through the service or by another agreed lawful channel. Keep relevant contacts current. Electronic notice may satisfy a writing requirement where law permits; sending to an invalid address does not excuse a notice requirement that law imposes on us. Send legal notices to legal@opengen.dev unless a specific legal process requires another method. Marketing choices are separate from necessary account, security and payment communications.',
        },
        {
          type: 'paragraph',
          text: "The adopted Terms will identify their version and effective date, and we will make the current text available. For a material change reducing rights or increasing obligations, we will give at least 30 days' advance notice by an appropriate account or in-product channel. A law-driven or urgent security/abuse change may take effect sooner only to the extent necessary, with notice as soon as reasonably possible and legally permitted. Minor corrections or changes solely benefiting users may take effect when published.",
        },
        {
          type: 'paragraph',
          text: 'Changes apply prospectively. They do not retroactively authorize a new charge, broader content use, a different paid request or forfeiture of an existing refund right. Continued future use after clear notice and the effective date can indicate acceptance only where legally permitted; where fresh affirmative agreement is required, we will obtain it before the affected activity. If you decline a material change and close because you cannot continue under the prior terms, we will return your unused purchased remainder after accepted-cost reconciliation even if the voluntary refund-request window has closed. Accrued rights and recovery of existing work remain. The prior version continues to govern an earlier accepted request or dispute to the extent applicable.',
        },
      ],
    },
    {
      id: 'section-19',
      title: '19. General contract provisions',
      blocks: [
        {
          type: 'paragraph',
          text: "These Terms, the credit policy and other documents expressly incorporated within their stated scope are the agreement for the hosted service, subject to section 2's priority rules. They do not erase a separately signed agreement, an accepted request commitment, accrued rights or the published software licenses. An amendment outside the stated update process must be agreed by authorized representatives.",
        },
        {
          type: 'paragraph',
          text: "Neither party may transfer the hosted agreement without the other's written consent, except that we may transfer it as part of a merger, reorganization or sale of the relevant business to a successor responsible for its obligations. We will provide appropriate notice and preserve applicable privacy, refund and consumer rights. Contract assignment does not enable sale of customer credentials, transfer of workspace balance through an unavailable feature or unrelated reuse of private content. Separate input/output and source-license rights remain governed by their applicable terms.",
        },
        {
          type: 'paragraph',
          text: 'If a provision is unenforceable, it is limited only as necessary and the remaining agreement continues where lawful. Not enforcing a provision once does not waive later enforcement. Section titles do not alter meaning. No unrelated third party receives rights under this agreement merely because it is mentioned; any expressly agreed third-party rights must be identified in the applicable agreement.',
        },
        {
          type: 'paragraph',
          text: 'Rights and obligations that need to continue after termination do so to that extent, including payment/cost reconciliation, valid refunds, lawful content rights, necessary records, accrued claims, dispute handling and the applicable liability/claim provisions. Survival does not create an indefinite content-use permission or override deletion and legal-retention limits.',
        },
      ],
    },
    {
      id: 'section-20',
      title: '20. Contact',
      blocks: [
        {
          type: 'paragraph',
          text: "OpenGen's operator is ATOMSTOBITS LABS INC., a Delaware corporation in the United States. Contact legal@opengen.dev for legal notices, privacy/rights requests and content complaints. Contact support@opengen.dev for accounts, generation, billing, refunds and service support. Include relevant identifiers and a concise explanation; do not send passwords, API secrets, private tokens or complete payment details.",
        },
        {
          type: 'paragraph',
          text: 'Our business and legal-notice mailing address is ATOMSTOBITS LABS INC., 201 Folsom St, San Francisco, CA 94105, United States.',
        },
      ],
    },
  ],
} satisfies LegalPolicy;

export const refundsPolicy = {
  slug: 'refunds',
  navigationLabel: 'Refund policy draft',
  title: 'OpenGen Prepaid Credit and Refund Policy — V4 proposed draft',
  description:
    'Proposed OpenGen prepaid-credit and refund policy. Draft for review, not yet effective.',
  reviewDate: '9 November 2026',
  sections: [
    {
      id: 'section-1',
      title: '1. Scope and priority',
      blocks: [
        {
          type: 'paragraph',
          text: "This policy covers the hosted OpenGen service operated by ATOMSTOBITS LABS INC. and forms part of its Terms of Service. It controls the specific funding, accounting and refund matters below; general Terms language does not remove these express refund rights. Mandatory legal rights take priority. The Privacy Notice governs personal-data handling. A quote sets that job's price basis and limits; it does not override this policy or authorize another card charge.",
        },
        {
          type: 'paragraph',
          text: 'Purchased credit is USD service prepayment of the paying workspace. One dollar of purchased balance provides one dollar toward authorized OpenGen charges. It is not a bank deposit or investment, earns no interest and cannot be transferred or resold through OpenGen. Cash returns follow this policy and law.',
        },
        {
          type: 'paragraph',
          text: 'The same accepted pricing, reservation, cancellation and settlement rules apply to generations submitted through the website, API, MCP or CLI. An interface does not itself make a paid request free or authorize another purchase. Any genuinely different offer must state its scope before you accept it.',
        },
      ],
    },
    {
      id: 'section-2',
      title: '2. Manual purchases and fees',
      blocks: [
        {
          type: 'paragraph',
          text: 'The initial purchase flow is a human-approved USD top-up of $5 to $1,000. We show the credit amount, total payment and any applicable fee or tax before payment. The initial separate OpenGen purchase fee and refund-processing fee are $0. A future separately implemented purchase fee must be clearly accepted at checkout; it may be nonrefundable only as disclosed and legally permitted. A processor charging OpenGen a fee does not itself authorize a refund deduction.',
        },
        {
          type: 'paragraph',
          text: 'This policy activates no subscriptions, auto-top-ups or promotional program. Saving a payment method, giving an agent Generate access or exhausting balance does not authorize another charge. Available payment methods are those actually shown at checkout; this policy does not add cryptocurrency or other methods.',
        },
        {
          type: 'paragraph',
          text: 'We add usable credit once after verified paid confirmation. A checkout redirect or pending payment instruction is not proof of funding. Keep the original order ID if credit is missing; ask us to check that payment before paying again.',
        },
      ],
    },
    {
      id: 'section-3',
      title: '3. Quotes, reservations and customer limits',
      blocks: [
        {
          type: 'paragraph',
          text: 'Check the exact model, regional route, inputs, resolution, duration, output count, payer, price basis and disclosed fees. Image/video rates can depend on configuration. A quote is an estimate unless expressly fixed; price and availability are rechecked at admission. An admitted job retains its accepted terms rather than being silently repriced later.',
        },
        {
          type: 'paragraph',
          text: "A reservation sets aside balance for a job; it is not a final debit or refund. For managed calls, the final OpenGen customer charge cannot exceed the accepted reservation or a stricter accepted request cap. OpenGen bears a supplier overrun above that customer limit; it does not silently debit more balance or charge your card. This does not cap a provider's direct charges when you use your own provider account/key.",
        },
        {
          type: 'paragraph',
          text: 'Any OpenGen generation fee must be separately shown and accepted. General Terms do not activate a source-only fee feature or contradict an advertised zero-markup route. Unknown acceptance/cost stays unresolved until reviewed; successful delivery, list price and an error response do not establish the final supplier bill. Do not submit a replacement merely because an existing job is slow or uncertain.',
        },
      ],
    },
    {
      id: 'section-4',
      title: '4. Paid balance, noncash grants and allocation',
      blocks: [
        {
          type: 'paragraph',
          text: 'The initial service makes no promise of free, referral or promotional credit. If we issue an identified noncash grant, its offer states its conditions. It is not purchased money and is not cash-refundable unless law requires otherwise. Correcting a paid billing error preserves its paid character rather than converting a refund into a promotion.',
        },
        {
          type: 'paragraph',
          text: 'For manual refund calculations, staff reconstruct funding and usage chronologically from original payment, job and ledger records. Noncash credit available when work was admitted is applied first; paid credit is then applied oldest purchase first. A later grant does not retroactively replace earlier paid consumption. Accepted reservations retain their allocation until settled/released; release restores the same funding character and purchase date. Prior cash returns count once.',
        },
        {
          type: 'paragraph',
          text: 'This is a support-accounting rule, not a claim of automated credit buckets or purchase-lot counters. We investigate uncertain origins rather than assuming the amount is paid refundable money or free credit. An undisputed paid remainder can be returned separately from genuinely unresolved accepted work.',
        },
      ],
    },
    {
      id: 'section-5',
      title: '5. Ordinary voluntary refund window',
      blocks: [
        {
          type: 'paragraph',
          text: 'Request the unused paid remainder within 24 hours of successful payment confirmation for the purchase. This does not start when an unpaid checkout opens. A timely request remains timely while staff verifies it or accepted costs are resolved. Partial use does not disqualify the entire purchase. Spending you authorize before the refund amount is secured reduces its unused remainder; stop using balance you want returned.',
        },
        {
          type: 'paragraph',
          text: 'The calculation excludes consumed amounts, prior refunds/returns, noncash grants and genuinely unresolved accepted-work exposure. It cannot exceed the original unreturned paid principal. We explain it. Missing funding, unauthorized/duplicate charges, service defects, closure and mandatory rights are separate review grounds; the voluntary window does not extinguish them.',
        },
        {
          type: 'paragraph',
          text: 'No new OpenGen refund deduction applies. Only an actual separately disclosed nonrefundable purchase fee could be excluded; that fee is currently zero. Any required adjustment of tax actually collected is separate, not a service fee.',
        },
      ],
    },
    {
      id: 'section-6',
      title: '6. Fractions of a cent and refund destination',
      blocks: [
        {
          type: 'paragraph',
          text: 'Usage uses integer millionths of a US dollar; cash refunds use cents. A positive refundable paid remainder is rounded up to a cent, limited by the remaining refundable principal of its original payment. OpenGen bears the sub-cent difference. We remove only the corresponding eligible paid credit and record that difference separately, rather than erase it as a fee or debit unrelated credit. There is no extra OpenGen minimum refund-request amount.',
        },
        {
          type: 'paragraph',
          text: "For example, $4.993456 eligible credit can produce a $5.00 cash refund if that original payment has at least $5.00 still returnable. Records show the exact credit removed and OpenGen's $0.006544 rounding cost. The same amount cannot be recovered twice through cash, bank reversal, restored credit or another support case.",
        },
        {
          type: 'paragraph',
          text: 'We normally refund the original method and verify the original payer/workspace authority. If that route cannot process an eligible return, support arranges a verified lawful alternative where needed. This does not promise that Stripe can redirect a refund to any card/bank or that all methods support identical partial refunds.',
        },
      ],
    },
    {
      id: 'section-7',
      title: '7. Manual handling and timing',
      blocks: [
        {
          type: 'paragraph',
          text: 'Email support@opengen.dev with your account/workspace, order or payment reference, requested amount and brief reason. Staff can help identify a purchase if you lack its ID. Do not send full card/bank details, passwords, API keys, tokens or unnecessary private generation content. Generation permission is not permission to send money to a different recipient.',
        },
        {
          type: 'paragraph',
          text: 'Our proposed initial staff targets are acknowledgement within one business day, a decision or specific information request within five business days, and processor initiation within two business days after approval and reconciliation of the amount being returned. These are manual targets, not refund automation or a bank-arrival guarantee. Earlier legal deadlines control. Staff delay does not make a timely request late.',
        },
        {
          type: 'paragraph',
          text: 'Before returning cash, staff secures the amount against reuse, preserves accepted-job liabilities, and records processor/refund and ledger references. Requested, approved, processor-pending, initiated and bank-received are different states. A failed refund is investigated, not marked completed or used to clear every hold automatically.',
        },
        {
          type: 'paragraph',
          text: 'Card returns commonly appear within five to ten business days after processor initiation; some are faster or appear as reversals, and method/bank delays can be longer. We provide the applicable estimate and available tracing reference. Contact support after ten business days or the stated method-specific estimate if it has not arrived. Use legal@opengen.dev to escalate unresolved handling/rights complaints.',
        },
      ],
    },
    {
      id: 'section-8',
      title: '8. Aged unresolved charges',
      blocks: [
        {
          type: 'paragraph',
          text: 'An acceptance/cost question unresolved for 24 hours enters manual billing review. We target a first explanation within two business days, billing-owner escalation at seven calendar days, and at least weekly updates. The explanation identifies the amount, issue, evidence sought and next review date; an unexplained indefinite hold is not the policy.',
        },
        {
          type: 'paragraph',
          text: 'By day 30, the billing owner must make a documented resolution decision: settle on reliable evidence within the customer limit, or provide an OpenGen-funded adjustment/return while preserving any genuinely unknown supplier-cost record. We do not invent zero upstream cost to release money. Continued restriction needs a specific legal/payment-network/fraud reason or credible ongoing accepted-work evidence, a limited amount and a next review date. Undisputed unreserved paid funds are not withheld simply because another item needs review. These are proposed manual obligations, not automatic time-based ledger rewrites.',
        },
      ],
    },
    {
      id: 'section-9',
      title: '9. Failure, cancellation and delivery remedies',
      blocks: [
        {
          type: 'paragraph',
          text: 'Work rejected before upstream acceptance with no incurred charge is not usage-billed; its applicable unused reservation is released. Accepted processing can remain billable after failure, attempted cancellation or delivery trouble. Accepted route terms and billing evidence determine the charge, not “failed” alone.',
        },
        {
          type: 'paragraph',
          text: 'Cancellation is not guaranteed after acceptance and does not establish a refund. Where recoverable, we resume the same job or retained delivery rather than create another paid generation without authority. Reservation release restores spending capacity; it is not cash back.',
        },
        {
          type: 'paragraph',
          text: "Report a billing error or failure to meet an accepted technical commitment. Remedies can include corrected delivery, a paid-credit adjustment or money back as appropriate under the facts and applicable rights. A supplier's no-refund rule does not eliminate OpenGen's own responsibilities. Disliking a creative result alone does not establish that the promised technical service failed.",
        },
      ],
    },
    {
      id: 'section-10',
      title: '10. Closure and service discontinuation',
      blocks: [
        {
          type: 'paragraph',
          text: 'Voluntary workspace closure, OpenGen closure without cause or permanent discontinuation of the paid service triggers reconciliation/return of unused paid balance, including outside the ordinary window. Our target is processor initiation within 30 calendar days of closure, subject to earlier legal deadlines and the specific unresolved amounts reviewed under section 8. Closure is not automatic paid-balance forfeiture; noncash grants do not become cash.',
        },
        {
          type: 'paragraph',
          text: 'For fraud, breach or payment-reversal review we may restrict new spending and lawfully offset established amounts owed, but do not declare all paid funds confiscated merely by closing an account. We explain retained/returned amounts where permitted. Export needed content first; necessary financial records follow the Privacy Notice and law.',
        },
      ],
    },
    {
      id: 'section-11',
      title: '11. Possible future expiry',
      blocks: [
        {
          type: 'paragraph',
          text: "There is no automatic paid-credit expiry schedule at launch. For credit sold under an adopted version of this policy, OpenGen reserves a discretionary right, where lawful, to expire unused paid credit no earlier than 365 days after purchase. We give at least 30 calendar days' direct advance notice, identify the affected amount/date, and allow use or a request to return its unused paid remainder before expiry. That return is an exception to the ordinary window.",
        },
        {
          type: 'paragraph',
          text: 'Exercise requires reliable paid-credit attribution and an audited adjustment. Unresolved reserved funds are not silently expired; if a hold prevented use/return during notice, we give a fresh opportunity after resolution. Mandatory legal exceptions and genuinely existing express no-expiry promises prevail. No automatic expiry is enabled at launch; any later exercise of this right must follow the notice, attribution and legal safeguards above.',
        },
      ],
    },
    {
      id: 'section-12',
      title: '12. Taxes, currency, statutory withdrawal and disputes',
      blocks: [
        {
          type: 'paragraph',
          text: "Funding/refund principal is in USD. A bank's conversion rate or separate card/FX charge can change its local-currency display; we do not impose or promise to reverse a bank's own fee. OpenGen tax/fees must be identified before approval; this policy neither enables tax automation nor authorizes an undisclosed debit. Required tax corrections use the actual transaction and law.",
        },
        {
          type: 'paragraph',
          text: 'Refunds, reversals, unauthorized payments or disputes can put new managed and own-key spending into review. Accepted jobs still need their original recovery/settlement; historical entries remain. We check processor/bank returns to avoid duplicate recovery. A failed refund or closed dispute does not automatically resolve every hold. For your own provider key, the provider receives its direct payment; OpenGen does not promise returns on its behalf.',
        },
        {
          type: 'paragraph',
          text: 'Tell us promptly about unauthorized or duplicate payments. Support does not require surrendering a lawful bank dispute, withdrawal, defective-service or other mandatory right. If immediate performance requires a separate legally required request/acknowledgement, obtain it clearly; login or a general agent grant does not supply it.',
        },
        {
          type: 'paragraph',
          text: 'Where EEA or UK consumer withdrawal law applies to your online purchase, you ordinarily have 14 days from concluding the contract to withdraw without giving a reason, subject to the applicable rules and exceptions. Send a clear statement of your decision to support@opengen.dev before the period ends, identifying the purchase and contact details; no special form or legal wording is required. The ordinary 24-hour voluntary window does not shorten this right or any longer period that law provides, including where required information was missing.',
        },
        {
          type: 'paragraph',
          text: 'For a valid statutory withdrawal, we make the reimbursement required by law without undue delay and ordinarily within 14 days after receiving your withdrawal notice, using the original payment method unless you expressly agree to another lawful method, with no reimbursement fee. We explain any lawful deduction or exception. A service begun at your express request and digital content supplied during the withdrawal period have different legal conditions; any proportional charge or loss of the right depends on the actual applicable information, request, consent, acknowledgement, performance and confirmation requirements. Purchasing credit, first use, login or agent access does not automatically satisfy them. We do not rely on an uncollected acknowledgement or treat every delivered generation as extinguishing all withdrawal rights.',
        },
      ],
    },
  ],
} satisfies LegalPolicy;

export const privacyPolicy = {
  slug: 'privacy',
  navigationLabel: 'Privacy draft',
  title: 'OpenGen Privacy Notice — proposed version 4',
  description: 'Proposed OpenGen Privacy Notice. Draft for review, not yet effective.',
  reviewDate: '9 November 2026',
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
          text: 'Contact legal@opengen.dev for privacy questions, rights requests, complaints and legal notices. Contact support@opengen.dev for account, generation, billing, refund and other service support. You do not need an OpenGen account to raise a privacy concern.',
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
          text: 'We determine how information is used for our own account administration, access controls, security, support, billing and legal obligations. Depending on applicable law, we act as a controller or business for that handling.',
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
      title: '3. Information and sources',
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
              'For an adopted, effective Terms version after validated Continue and verified sign-in: identity-provider issuer and account subject, Terms version and content fingerprint, fixed notice version/action/verification method, and database timestamp. This documents the identified Terms and action associated with the verified account; draft-policy sign-in creates no such receipt. The receipt adds no separate email, IP-address or device data, prompts, media or tokens.',
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
              'Workspace/order/payment identifiers, amount, currency, reconciliation, refund and dispute status from the payer or Stripe; accounting records created by the service',
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
          text: 'Some information is necessary for a requested feature: verified identity for account access, required model inputs for generation, a destination for an authorized webhook, and payment information for a credit purchase. Without it, that feature may not work. Optional labels, support context and model parameters need not be supplied unless the workflow requires them. Do not submit unnecessary sensitive information, complete payment details or passwords. Use designated connection controls for provider secrets.',
        },
        {
          type: 'paragraph',
          text: 'Stripe handles payment entry. Our normal payment journal stores minimized transaction linkage/status, rather than complete card/bank credentials or raw payment webhook bodies. Stripe separately handles information required for its payment, fraud-prevention and legal functions.',
        },
      ],
    },
    {
      id: 'section-4',
      title: '4. Purposes and legal bases',
      blocks: [
        {
          type: 'paragraph',
          text: 'We use information for the purposes below. Where a law requires a legal basis, it depends on the information, relationship and activity. Service use is not blanket consent to every purpose.',
        },
        {
          type: 'table',
          columns: ['Purpose', 'Basis where applicable'],
          rows: [
            [
              'Authenticate, manage a workspace, and provide requested generation, recovery and delivery',
              "Performance of a contract with you where necessary for that contract; legitimate interests in operating an authorized organizational service where appropriate for people who are not parties to that contract, subject to required balancing; the customer's documented instructions where we act as its processor",
            ],
            [
              'Record prices/usage, prevent duplicate paid work, reconcile costs/payments and provide support',
              'Contract where applicable; our legitimate interests in reliable service and accurate records, subject to the balancing required by law',
            ],
            [
              'Enforce access, detect misuse, investigate incidents and protect users/systems/rights',
              'Our legitimate interests in security and fraud prevention, and specific legal obligations where applicable',
            ],
            [
              'Keep required financial records, comply with binding process and address legal claims',
              'Relevant legal obligations; establishing, exercising or defending claims where applicable',
            ],
            [
              'Carry out a genuinely optional use for which we request consent',
              'Consent for that stated use, which may be withdrawn without changing the lawfulness of prior handling',
            ],
          ],
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
      title: '5. Private workspaces, clients and delivery',
      blocks: [
        {
          type: 'paragraph',
          text: 'Generations are private to the owning workspace and authorized identities/scopes. Authorized members, API keys and agent grants can access information allowed by their permissions. Team privacy is not creator-only privacy. Administrators can manage access and inspect activity available to their role. Necessary operational processing by OpenGen and its service providers still occurs.',
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
          text: 'We may disclose relevant information when legally required or reasonably necessary for security/fraud investigations, rights protection or legal claims. Disclosure remains tied to that purpose. These operational disclosures do not authorize sale or unrelated advertising use of private generation content.',
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
      title: '7. Cookies and browser storage',
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
              'Payment-order recovery, certain completed comparison identifiers and a random cross-tab session-change signal; persists until the application clears the record or you clear site data',
            ],
          ],
        },
        {
          type: 'paragraph',
          text: 'Authentication cookies are HttpOnly, SameSite=Lax and Secure on HTTPS. Payment recovery is limited to workspace/order/amount and duplicate-prevention identifiers, not card details, provider keys or checkout links. Its record is cleared after an authenticated read confirms the relevant terminal order state. Browser records/checkout returns do not themselves prove payment or generation acceptance.',
        },
        {
          type: 'paragraph',
          text: 'Browser controls can clear or block cookies/storage. This can sign you out, remove local drafts or prevent safe recovery/funding. It does not delete server-side jobs, media or financial records. On a shared device, clear site data when appropriate after ending your work.',
        },
        {
          type: 'paragraph',
          text: 'Hosting, edge, sign-in and payment services can also handle technical information or use their own functional/security technologies for the requested interaction. This inventory is not a promise that linked third-party pages are cookie-free or infrastructure keeps no logs. It does not authorize unrelated advertising, session replay or model training. If we introduce optional processing requiring a choice or consent, we will provide the relevant information and controls before it begins where required. Contact legal@opengen.dev about cookie/storage or other choices. Applicable opt-out rights or legally recognized browser signals are not waived by service use.',
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
              'Evidence of the identified agreement and related legal claims or required preservation, retained only while necessary for the justified purpose. Ordinary application operations preserve the original receipt without automatic expiry; sign-out, account closure and media cleanup do not automatically erase it. Correction/deletion requests require review, and any record retained for a justified exception remains limited to that purpose. A scoped operator retention/disposition record and reviewed procedure are required before acceptance recording is activated; this draft sets no uniform deadline.',
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
      title: '9. International processing',
      blocks: [
        {
          type: 'paragraph',
          text: 'OpenGen is operated from the United States. Infrastructure, providers, routes and authorized clients may process/access information elsewhere. An endpoint region does not establish every inference, storage, support, account, security or payment location. Unknown regions are not a residency guarantee.',
        },
        {
          type: 'paragraph',
          text: 'Where law requires transfer safeguards, the relevant processing must have an applicable arrangement, such as a lawful adequacy basis or appropriate contractual safeguards, as the actual circumstances require. We do not claim every route has executed Standard Contractual Clauses, a certification, EU-only processing or identical protections. Service use is not consent to waive required safeguards.',
        },
        {
          type: 'paragraph',
          text: 'Contact legal@opengen.dev for relevant locations/safeguards or a copy/description of applicable safeguards, subject to legitimate confidentiality/security redactions. Arrange required business processing/transfer terms before submitting covered information. If a required protection is unavailable for a route, use a suitable alternative arrangement.',
        },
      ],
    },
    {
      id: 'section-10',
      title: '10. Rights, requests, appeals and complaints',
      blocks: [
        {
          type: 'paragraph',
          text: 'Depending on the law, our role and the information, rights may include know/access/copy, correction, deletion, restriction, portability, objection, withdrawal of optional consent, limits on sensitive-data use and opt-outs from sale, sharing or targeted advertising where those activities/rights apply. Protections concerning solely automated decisions with legal or similarly significant effects may also apply. Rights and exceptions differ by jurisdiction.',
        },
        {
          type: 'paragraph',
          text: 'Write to legal@opengen.dev, describing the action and enough context to locate the information. You may write if someone else uploaded information about you, you lack a job ID, or you have no account. We may proportionately verify identity, authority and the records concerned; do not send passwords, API keys or complete payment details. An authorized representative may contact us with legally required authority. Depending on the request, we may need your confirmation; verification is not permission to collect unrelated information.',
        },
        {
          type: 'paragraph',
          text: "We will not require identity verification for an opt-out that applicable law requires us to honor without it, or require an account to exercise such a choice. We honor legally required browser preference signals where applicable; the absence of a relevant sale or advertising activity does not authorize introducing it without the required information and choices. Where California's direct-marketing disclosure right applies, residents may request the relevant information about disclosures to third parties for their own direct-marketing purposes through legal@opengen.dev.",
        },
        {
          type: 'paragraph',
          text: 'For customer-directed information, we may refer/relay a request to the responsible organization and assist as law/agreement requires. This does not remove our responsibility for information we control. We will explain an applicable denial, exception, fee or extension. We do not discriminate for exercising applicable rights, although a choice can affect a feature that genuinely needs the information.',
        },
        {
          type: 'paragraph',
          text: 'We respond within the applicable deadline. Under the EU GDPR, the usual period is one month from receipt, with up to two additional months where legally permitted/necessary and notice/reasons within the first month. For California know/delete/correct requests governed by the CCPA, the usual period is 45 calendar days, with a further 45 days where permitted and required notice. Other requests/jurisdictions can have different or shorter periods and verification/extension rules. These examples do not assert every law applies to every user or activity.',
        },
        {
          type: 'paragraph',
          text: "To request review, reply to a decision or email legal@opengen.dev with “Privacy appeal” and your reason. We will review it and provide the explanation/outcome required by applicable law. You may complain to a competent regulator or seek a remedy without completing an internal appeal where law permits. Depending on location, this can include an EEA data protection authority, the UK Information Commissioner's Office, the Swiss Federal Data Protection and Information Commissioner or a relevant US state authority. We can help identify the channel. No OpenGen contract removes a mandatory complaint/remedy right.",
        },
      ],
    },
    {
      id: 'section-11',
      title: "11. Children and other people's information",
      blocks: [
        {
          type: 'paragraph',
          text: "Accounts and direct use are intended for people aged 18 or older. We do not invite children to open accounts. This eligibility rule does not claim collection of identity documents or automated verification of every visitor's age.",
        },
        {
          type: 'paragraph',
          text: "An adult's upload depicting a child is separate from a child holding an account. The uploader needs required rights/authority and must meet applicable child-privacy/safety and model/provider restrictions. Do not submit unlawful, exploitative or prohibited material. A parent, guardian or concerned person may report an underage account or child's information to legal@opengen.dev without an account. We will assess it, restrict activity where appropriate and take legally required removal/other action, subject to necessary legal/security preservation.",
        },
      ],
    },
    {
      id: 'section-12',
      title: '12. Sensitive information and automated processing',
      blocks: [
        {
          type: 'paragraph',
          text: 'Content may reveal health, identity, beliefs or other sensitive matters and identify people by face/voice. A recognizable image or recording is not automatically a biometric identifier used for unique identification; purpose and processing matter. This notice does not authorize a new identity-verification, biometric-identification or sensitive-data use.',
        },
        {
          type: 'paragraph',
          text: 'Submit only information you are authorized to use, through a suitable route. If a legal condition or contractual protection is required, put it in place first. Providers may process differently; their rules cannot be inferred from workspace privacy. Feature-specific information, permissions or legal conditions must be addressed for that feature, not assumed from general use.',
        },
        {
          type: 'paragraph',
          text: "Generation, validation, routing and access controls involve automation. Creative generation is not itself a determination of legal rights or eligibility. Contact legal@opengen.dev about an automated restriction, consequential decision or information about you for review and applicable information/intervention rights. We do not claim every upstream model's internals are known or that no automated security decision can affect access.",
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
      title: '14. Changes and contact',
      blocks: [
        {
          type: 'paragraph',
          text: 'An adopted notice will state its version/effective date. We will explain material changes and provide notice or choices where required before affected new processing. An update is not permission for unrelated use of existing private generations or waiver of mandatory rights.',
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
  title: 'OpenGen Business Data Processing Addendum — proposed version 2',
  description:
    'Proposed OpenGen business data processing addendum. Draft only; not executed or automatically incorporated.',
  reviewDate: '9 November 2026',
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
          text: 'The parties will work in good faith on a suitable alternative, configuration or protection. OpenGen will not begin the objected-to new processing while the objection remains unresolved. If no compliant arrangement is reasonably available, either party may end the affected part of the service, with return/deletion and unused-paid-balance consequences under this Addendum and the credit policy. No new unapproved paid generation is authorized to repair the situation.',
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
          text: "This Addendum controls a conflict concerning its instructed processing; mandatory law and an applicable overriding transfer instrument take priority. The credit policy continues to control funding/refund arithmetic, and the Privacy Notice separately describes OpenGen's own controller activities. Nothing here forfeits owed credit/refunds or expands the source-code license restrictions.",
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
  title: 'OpenGen Business Subprocessor Schedule — proposed version 2',
  description:
    'Proposed OpenGen business subprocessor schedule. Draft only; not executed supplier authorization.',
  reviewDate: '9 November 2026',
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
  refundsPolicy,
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
