# Staff relief for aged unresolved generation cost

The internal `AgedCostReliefStore` provides the funded adjustment contemplated by
Credit Policy section 8. A current installation billing operator and a separate
approval of the original funding allocation are required. The store is closed
unless trusted server composition explicitly selects `staff-approved`. It has no
HTTP, MCP, customer, agent, scheduler, provider or cash-payment entry point.

## What the adjustment does

For one managed job with a positive unresolved reservation `R`, staff may advance
exactly `R` into the same paying workspace. There is one immutable decision per
job. Eligibility starts at the policy's 24-hour manual-review point, measured by
database time from the earliest durable provider attempt. A rejected attempt does
not establish zero supplier cost. An admitted fallback with that predecessor can
still have unresolved exposure. The day-30
decision remains an operator obligation. This operation performs no automatic
age-based adjustment.

The original reservation, key-budget hold, upstream identity, attempt credentials,
dispatch journal, accepted request/cap, unknown supplier cost and recovery state
remain intact. The operation records an OpenGen-funded advance and its provenance.
It does not call the provider or assert acceptance, failure, cancellation or zero
cost. A staff review can still resume the original uncertain attempt using the
existing evidence-based reconciliation path.

When reliable evidence later establishes the original bounded gross customer
charge `C`, the ordinary settlement path records that cost and releases `R-C`.
The same transaction offsets exactly that newly released unused advance. It does
not recover money from another reservation or unrelated available funds.

| Stage                                     | Available effect for this job | Reserved effect |
| ----------------------------------------- | ----------------------------- | --------------- |
| Original admission                        | `-R`                          | `+R`            |
| Approved full advance                     | `+R`                          | `0`             |
| Reliable late settlement                  | `+(R-C)`                      | `-R`            |
| Unused advance offset in that transaction | `-(R-C)`                      | `0`             |
| Completed contribution                    | `0`                           | `0`             |

The customer's net charge for this job is zero. OpenGen funds `C` and retains any
supplier overrun already assigned to the operator by the original accepted terms.
Actual supplier cost and ordinary gross charge remain in their existing records.
The late receipt explicitly identifies the advance, gross charge, recovered unused
amount, operator-funded amount and zero net customer charge. A genuinely evidenced
zero cost recovers the whole unused advance from the reservation release. Unknown
cost continues to be unknown.

Cancellation or queue expiry can close the remaining queued fallback while its
earlier supplier bill stays unresolved. Those paths retain the original financial
reservation and key hold. A later submission rejection after relief also retains
unknown cost. The original evidence path can settle a genuinely established zero
or positive cost without an automatic rejection being treated as billing proof.

Legacy fallback jobs can retain unverified predecessor costs. The late receipt
identifies the current attempt covered by the normal settlement evidence and
keeps every other attempt's supplier cost null, with its original identity. The
staff queue retains an `operator-funded-predecessor-cost-unverified` item even
after that job settles. Aggregate supplier liability remains partially unverified.
Any later predecessor liability belongs to OpenGen and cannot trigger
another customer debit or wallet correction through this operation. Staff must
retain that separate supplier investigation and its evidence references.

The original key-month hold stays held until ordinary reliable settlement. Its
gross debit then follows the original settlement and admission month. Relief does
not replenish a key quota, move exposure to another month or remove earlier gross
usage. Existing accepted work continues through its original recovery path.
For legacy multi-attempt jobs, this preserves the existing bounded gross budget
accounting; it does not certify that every supplier invoice has been reconciled.

## Manual procedure

1. Open the case after an acceptance/cost question has remained unresolved for
   24 hours. Record the original request time, job and paying workspace, amount,
   issue, evidence sought, policy version and next review date. Target the first
   explanation within two business days, billing-owner escalation at seven
   calendar days and weekly updates. By day 30, document reliable settlement or
   the funded adjustment/return decision.
2. Inspect the original provider attempt and accepted request. Confirm that cost
   and customer settlement remain unresolved. Never use a fake rejection,
   `settle(0)`, a guessed supplier charge or a replacement generation to end the
   uncertainty. A never-submitted queued job, settled job or zero-reserve BYOK job
   cannot use this operation.
3. Reconstruct the original reservation's funding chronology. Select original
   positive funding ledger IDs and their allocated micro-USD amounts, totalling
   exactly `R`. The store verifies the source records and derives paid versus
   noncash character. Paid entries require the original credited payment and its
   canonical processor ownership. Their original payment creation/credit dates,
   account, mode, PaymentIntent and reference are retained. Opening/operator
   funding remains noncash. A later grant cannot retroactively replace earlier
   paid consumption. Trace a prior relief correction to its original funding
   records rather than treating its advance as another purchase.
   New ledger entries carry an immutable posting order assigned under the
   workspace money lock. That order can reject a later source even when its
   transaction began earlier. Historical posting order remains null. Transaction
   timestamps alone do not prove original availability; legacy allocation needs
   independently verified chronology. The receipt records which basis applies.
4. Call `review({ workspaceId, jobId, allocation }, staffContext)` on the internal
   store. Retain the returned snapshot/hash and derived allocation for the case.
   The trusted independent approval must establish actual chronology, prior cash
   returns and customer eligibility. A source credit's face amount or a worksheet
   hash alone does not prove the eligible remainder.
5. Have the authorized approval process bind this exact policy, job, original
   exposure snapshot, funding allocation, decision reference, note and evidence.
   Both callbacks use the supplied transaction client for reads and revalidation.
   They must not commit, acquire another connection, perform network I/O or change
   money. Ordinary workspace administration and agent/generation permissions do
   not implement these callbacks.
6. Call `grant({ workspaceId, jobId, allocation, reference, note, evidenceUrl,
snapshotHash }, staffContext)`. The operation revalidates staff and approval
   under the workspace/job locks. Keep the immutable receipt and positive credit
   ledger ID. Exact request replay returns the first receipt. Another decision or
   changed request for the same job fails without another adjustment.
7. Explain the funded adjustment and remaining supplier investigation to the
   customer. If a cash return is appropriate, use the separately authorized
   original-payment refund process and its current allocation review. The relief
   grant creates no refund order, card mandate or new cash-purchase principal.
   Refund review evidence includes the relief allocation and late offset so paid
   corrections retain their original purchase character and age.
8. Keep the original job's polling, evidence and accepted recovery operational.
   Reliable late evidence follows the normal provider/operator settlement path.
   Inspect its single linked relief-settlement receipt. Replayed evidence must
   not debit the customer or create another correction. Unsupported fee evidence
   remains pending under the original verification rules.
   `getReceipt({ workspaceId, jobId }, staffContext)` reads the original grant and
   its pending or completed late-settlement receipt, including after resolution.

Relief does not clear processor, fraud, legal or other independent holds. Any
continued restriction needs the policy's specific reason, limited amount and next
review date. An unrelated unknown item does not justify withholding undisputed
unreserved paid funds. Record the customer communication and next owner action.

## Source and migration ownership

Core owns migration 031, following payments' reserved 030 and the integrated Terms
receipt migration 029. Earlier SQL is immutable. The new grant and late-settlement
receipts, their linked ledger entries and their source identity are protected by
transactional guards. Native qualification must cover concurrent grants and late
evidence, exact replay, paid-origin preservation, true zero/partial/full/over-cap
cost, unrelated reservations, fee evidence and a populated upgrade/restore.
New posting-order entries require sequence usage under the runtime role, alongside
the existing reviewed table privileges. Qualify that role on the disposable
native schema before deployment. No historical ordering is backfilled.

Fixture results establish software behavior. Policy publication/effective dates,
actual staff composition, protected resource access and each real financial
operation require their separately reviewed admission. The fixture authority and
synthetic funding records are not a production staff approval process.
