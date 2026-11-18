# TrustVendor checklist score

## What the score means

The score is a **0–100 open-evidence exposure indicator** for the five review checks. It reports how many checklist points have not yet been cleared by a reviewer. It is not a probability of fraud, a credit score, a legal opinion, or a guarantee that a supplier is trustworthy.

| Review check | Points |
| --- | ---: |
| Business registration | 25 |
| Tax identity | 20 |
| Bank account ownership | 25 |
| Sanctions screening | 20 |
| Business address | 10 |

For each check, a `verified` status subtracts its points from 100. `pending` and `missing` statuses keep those points open. A `flagged` check also keeps its points open and forces the displayed risk level to High. Otherwise the level is High at 60 or more, Medium at 30–59, and Low below 30.

## Evidence rules

- A reviewer must enter a note for every non-pending status.
- Verified and flagged checks must include an evidence source.
- The audit log records who changed a record, when, which check changed, and the status transition. It avoids copying reviewer notes into the audit record.
- The application does not contact the source or determine whether the reviewer’s conclusion is correct.

## Use limits

The point weights are initial workflow weights chosen to make outstanding evidence visible. They have not been calibrated against historical supplier outcomes or validated by procurement users. Do not automate purchasing decisions, reject a supplier, or make legal/compliance claims solely from this score. Review the point weights with intended users and qualified domain specialists before production use.
