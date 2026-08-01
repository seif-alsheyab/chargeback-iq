-- Reference data seed. Sourced from Visa and Mastercard published rules
-- current as of 2026. Rules change; treat this as a starting point that
-- operations reviews, not as permanent truth.

INSERT INTO card_networks (code, name, monitoring_program) VALUES
  ('VISA',       'Visa',             'VAMP'),
  ('MASTERCARD', 'Mastercard',       'ECP'),
  ('AMEX',       'American Express', 'NONE'),
  ('DISCOVER',   'Discover',         'NONE');

INSERT INTO dispute_categories (code, name, description, counts_as_fraud) VALUES
  ('FRAUD',            'Fraud',
   'Cardholder states they did not authorise the transaction. Includes counterfeit, stolen credentials and card-absent fraud.', true),
  ('AUTHORIZATION',    'Authorization',
   'The transaction was processed without valid authorisation, or against a declined or expired approval.', false),
  ('PROCESSING_ERROR', 'Processing Error',
   'Mechanical fault in how the transaction was submitted: wrong amount, wrong currency, duplicate, late presentment.', false),
  ('CONSUMER_DISPUTE', 'Consumer Dispute',
   'Cardholder authorised the payment but disputes the outcome: goods not received, not as described, cancelled recurring, credit not processed.', false);

-- ---------- Visa reason codes (VCR framework) ----------
INSERT INTO reason_codes (network_code, code, title, category_code, workflow, evidence_guidance) VALUES
  ('VISA','10.1','EMV Liability Shift Counterfeit Fraud','FRAUD','ALLOCATION','Terminal EMV capability records. Rarely winnable if the terminal was non-compliant.'),
  ('VISA','10.2','EMV Liability Shift Non-Counterfeit Fraud','FRAUD','ALLOCATION','Proof of PIN verification or chip authentication.'),
  ('VISA','10.3','Other Fraud - Card Present Environment','FRAUD','ALLOCATION','Signed receipt, imprint, or proof card was present.'),
  ('VISA','10.4','Other Fraud - Card Absent Environment','FRAUD','ALLOCATION','AVS/CVV match, 3DS authentication, device fingerprint, prior undisputed transaction history from same cardholder. Compelling Evidence 3.0 applies here.'),
  ('VISA','10.5','Visa Fraud Monitoring Program','FRAUD','ALLOCATION','Effectively undefendable. Signals the merchant is already in a monitoring programme.'),
  ('VISA','11.1','Card Recovery Bulletin','AUTHORIZATION','ALLOCATION','Proof the card was not listed at the time of authorisation.'),
  ('VISA','11.2','Declined Authorization','AUTHORIZATION','ALLOCATION','Authorisation logs showing an approval code was received.'),
  ('VISA','11.3','No Authorization','AUTHORIZATION','ALLOCATION','Authorisation record with approval code and timestamp.'),
  ('VISA','12.1','Late Presentment','PROCESSING_ERROR','COLLABORATION','Settlement timestamps proving submission inside the required window.'),
  ('VISA','12.2','Incorrect Transaction Code','PROCESSING_ERROR','COLLABORATION','Original transaction record showing the correct code.'),
  ('VISA','12.3','Incorrect Currency','PROCESSING_ERROR','COLLABORATION','Proof of currency disclosure and cardholder acceptance at checkout.'),
  ('VISA','12.4','Incorrect Account Number','PROCESSING_ERROR','COLLABORATION','Authorisation record matching the account charged.'),
  ('VISA','12.5','Incorrect Amount','PROCESSING_ERROR','COLLABORATION','Signed or accepted order total matching the settled amount.'),
  ('VISA','12.6','Duplicate Processing / Paid by Other Means','PROCESSING_ERROR','COLLABORATION','Two distinct order records, or proof the other payment failed.'),
  ('VISA','12.7','Invalid Data','PROCESSING_ERROR','COLLABORATION','Authorisation request showing valid data was transmitted.'),
  ('VISA','13.1','Merchandise / Services Not Received','CONSUMER_DISPUTE','COLLABORATION','Delivery confirmation, tracking, signature, or proof of digital access and service usage logs.'),
  ('VISA','13.2','Cancelled Recurring Transaction','CONSUMER_DISPUTE','COLLABORATION','Cancellation policy acceptance, absence of a cancellation request, notification records.'),
  ('VISA','13.3','Not as Described or Defective','CONSUMER_DISPUTE','COLLABORATION','Product description at time of purchase, photos, specifications, terms accepted.'),
  ('VISA','13.4','Counterfeit Merchandise','CONSUMER_DISPUTE','COLLABORATION','Proof of authenticity and supply chain documentation.'),
  ('VISA','13.5','Misrepresentation','CONSUMER_DISPUTE','COLLABORATION','Marketing material and terms as presented at purchase.'),
  ('VISA','13.6','Credit Not Processed','CONSUMER_DISPUTE','COLLABORATION','Refund record with date and amount, or the policy stating no refund was due.'),
  ('VISA','13.7','Cancelled Merchandise / Services','CONSUMER_DISPUTE','COLLABORATION','Cancellation terms accepted at purchase and cancellation timeline.'),
  ('VISA','13.8','Original Credit Transaction Not Accepted','CONSUMER_DISPUTE','COLLABORATION','Proof the credit was delivered and accepted.'),
  ('VISA','13.9','Non-Receipt of Cash or Load Transaction Value','CONSUMER_DISPUTE','COLLABORATION','Records showing value was loaded or dispensed.');

-- ---------- Mastercard reason codes ----------
-- Mastercard consolidated many older codes into 4853 and 4834, so the list is
-- shorter than Visa's while covering the same ground.
INSERT INTO reason_codes (network_code, code, title, category_code, workflow, evidence_guidance) VALUES
  ('MASTERCARD','4837','No Cardholder Authorization','FRAUD','SINGLE_TRACK','AVS/CVC match, 3DS authentication, prior transaction history, delivery to a verified address.'),
  ('MASTERCARD','4840','Fraudulent Processing of Transactions','FRAUD','SINGLE_TRACK','Proof each transaction was separately authorised by the cardholder.'),
  ('MASTERCARD','4849','Questionable Merchant Activity','FRAUD','SINGLE_TRACK','Usually tied to a Mastercard security programme listing. Very difficult to defend.'),
  ('MASTERCARD','4870','Chip Liability Shift','FRAUD','SINGLE_TRACK','Proof of chip-capable terminal and successful chip read.'),
  ('MASTERCARD','4871','Chip / PIN Liability Shift','FRAUD','SINGLE_TRACK','Proof of PIN entry and chip authentication.'),
  ('MASTERCARD','4808','Authorization-Related Chargeback','AUTHORIZATION','SINGLE_TRACK','Authorisation approval code and timestamp.'),
  ('MASTERCARD','4831','Transaction Amount Differs','PROCESSING_ERROR','SINGLE_TRACK','Order record and cardholder-accepted total.'),
  ('MASTERCARD','4834','Point-of-Interaction Error','PROCESSING_ERROR','SINGLE_TRACK','Covers duplicates, wrong amount and currency errors. Provide the original transaction record.'),
  ('MASTERCARD','4842','Late Presentment','PROCESSING_ERROR','SINGLE_TRACK','Settlement timestamps.'),
  ('MASTERCARD','4846','Correct Transaction Currency Code Not Provided','PROCESSING_ERROR','SINGLE_TRACK','Currency disclosure at checkout.'),
  ('MASTERCARD','4850','Installment Billing Dispute','CONSUMER_DISPUTE','SINGLE_TRACK','Installment agreement accepted by the cardholder.'),
  ('MASTERCARD','4853','Cardholder Dispute','CONSUMER_DISPUTE','SINGLE_TRACK','Broad code covering not-received, not-as-described and cancelled recurring. Evidence depends on the sub-claim.'),
  ('MASTERCARD','4855','Goods or Services Not Provided','CONSUMER_DISPUTE','SINGLE_TRACK','Delivery confirmation or proof of service completion.'),
  ('MASTERCARD','4859','Addendum, No-show, or ATM Dispute','CONSUMER_DISPUTE','SINGLE_TRACK','Signed authorisation for the addendum charge or no-show policy acceptance.'),
  ('MASTERCARD','4860','Credit Not Processed','CONSUMER_DISPUTE','SINGLE_TRACK','Refund record, or the accepted policy showing no refund was due.');

-- ---------- Lifecycle states ----------
INSERT INTO dispute_statuses (code, name, description, is_terminal, is_won, sort_order) VALUES
  ('PRE_DISPUTE_ALERT','Pre-Dispute Alert',
   'An early-warning alert arrived before any formal chargeback. Resolving here (refund or RDR) stops the case counting toward monitoring ratios.', false, NULL, 10),
  ('INQUIRY','Inquiry / Retrieval Request',
   'The issuer requested transaction information. Not yet a chargeback, but ignoring it usually causes one.', false, NULL, 20),
  ('CHARGEBACK_RECEIVED','Chargeback Received',
   'A formal chargeback was filed. Funds are debited and the response clock starts.', false, NULL, 30),
  ('UNDER_REVIEW','Under Review',
   'An operator is assessing the case and deciding whether to fight or accept.', false, NULL, 40),
  ('ACCEPTED','Accepted',
   'The merchant conceded without representment. Deliberate loss, usually because evidence is weak or the amount is below the cost of fighting.', true, false, 50),
  ('REPRESENTED','Represented',
   'An evidence package was submitted to contest the chargeback. Awaiting the issuer decision.', false, NULL, 60),
  ('PRE_ARBITRATION','Pre-Arbitration',
   'The issuer rejected the representment and escalated. A second, narrower response window applies.', false, NULL, 70),
  ('ARBITRATION','Arbitration',
   'The network is deciding. Binding, and it carries fees regardless of who wins.', false, NULL, 80),
  ('WON','Won',
   'The dispute resolved in the merchant favour and the funds were retained or returned.', true, true, 90),
  ('LOST','Lost',
   'The dispute resolved against the merchant. Funds stay with the cardholder.', true, false, 100),
  ('EXPIRED','Expired',
   'The response deadline passed with no submission. Operationally identical to a loss, but tracked separately because it is a process failure, not an evidence failure.', true, false, 110),
  ('WITHDRAWN','Withdrawn',
   'The issuer or cardholder withdrew the dispute before resolution.', true, true, 120);

-- ---------- The state machine ----------
INSERT INTO status_transitions (from_status, to_status, triggered_by, requires_evidence, description) VALUES
  ('PRE_DISPUTE_ALERT','CHARGEBACK_RECEIVED','PROCESSOR_EVENT',false,'Alert was not resolved in time and became a formal chargeback.'),
  ('PRE_DISPUTE_ALERT','WITHDRAWN','OPERATOR',false,'Resolved at the alert stage, typically by refunding before the chargeback is filed.'),
  ('INQUIRY','CHARGEBACK_RECEIVED','PROCESSOR_EVENT',false,'The issuer escalated the inquiry into a chargeback.'),
  ('INQUIRY','WITHDRAWN','PROCESSOR_EVENT',false,'The issuer was satisfied by the information supplied.'),
  ('CHARGEBACK_RECEIVED','UNDER_REVIEW','OPERATOR',false,'An operator picked the case up for assessment.'),
  ('CHARGEBACK_RECEIVED','EXPIRED','SYSTEM',false,'The response deadline passed with no action.'),
  ('UNDER_REVIEW','ACCEPTED','OPERATOR',false,'Decision taken not to contest.'),
  ('UNDER_REVIEW','REPRESENTED','OPERATOR',true,'Evidence package submitted to contest the chargeback.'),
  ('UNDER_REVIEW','EXPIRED','SYSTEM',false,'The response deadline passed while the case sat in review.'),
  ('REPRESENTED','WON','PROCESSOR_EVENT',false,'The issuer accepted the evidence.'),
  ('REPRESENTED','LOST','PROCESSOR_EVENT',false,'The issuer rejected the evidence and did not escalate.'),
  ('REPRESENTED','PRE_ARBITRATION','PROCESSOR_EVENT',false,'The issuer rejected the evidence and escalated.'),
  ('PRE_ARBITRATION','ARBITRATION','OPERATOR',true,'Contested again; the network will decide.'),
  ('PRE_ARBITRATION','ACCEPTED','OPERATOR',false,'Conceded rather than pay arbitration fees.'),
  ('PRE_ARBITRATION','LOST','PROCESSOR_EVENT',false,'Resolved against the merchant at pre-arbitration.'),
  ('PRE_ARBITRATION','EXPIRED','SYSTEM',false,'The pre-arbitration response window passed with no action.'),
  ('ARBITRATION','WON','PROCESSOR_EVENT',false,'The network ruled for the merchant.'),
  ('ARBITRATION','LOST','PROCESSOR_EVENT',false,'The network ruled against the merchant.');

-- ---------- Deadline rules ----------
-- Network baseline is 30 days, but acquirers compress it. Region and
-- processor overrides win over the DEFAULT row at lookup time.
INSERT INTO deadline_rules (network_code, stage, region, processor_code, response_days, warn_days_before, notes) VALUES
  ('VISA','CHARGEBACK_RECEIVED','DEFAULT',NULL,30,5,'Visa network baseline for the dispute response.'),
  ('VISA','CHARGEBACK_RECEIVED','US',NULL,9,3,'Compressed acquirer window for US-processed payments.'),
  ('VISA','CHARGEBACK_RECEIVED','CA',NULL,9,3,'Compressed acquirer window for Canada-processed payments.'),
  ('VISA','CHARGEBACK_RECEIVED','EU',NULL,18,4,'Compressed acquirer window outside US/Canada.'),
  ('VISA','PRE_ARBITRATION','DEFAULT',NULL,30,5,'Pre-arbitration response window.'),
  ('VISA','ARBITRATION','DEFAULT',NULL,10,2,'Escalation to arbitration must be filed quickly.'),
  ('MASTERCARD','CHARGEBACK_RECEIVED','DEFAULT',NULL,45,7,'Mastercard second presentment window.'),
  ('MASTERCARD','PRE_ARBITRATION','DEFAULT',NULL,30,5,'Pre-arbitration response window.'),
  ('MASTERCARD','ARBITRATION','DEFAULT',NULL,10,2,'Arbitration filing window.');
